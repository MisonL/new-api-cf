#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createMockServer } from './mock-openai.mjs';

const PRIMARY_PORT = 18891;
const SECONDARY_PORT = 18892;
const EDGE_PORT = 18894;
const ADMIN_TOKEN = 'admin-dev-token';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EDGE_DIR = path.resolve(SCRIPT_DIR, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${stdout}\n${stderr}`.trim());
  }

  return { stdout, stderr };
}

async function waitForWorker(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(500);
  }
  throw new Error(`worker did not become ready: ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGKILL');
  }
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(3000)
  ]);
}

async function requestJson(pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('authorization', `Bearer ${ADMIN_TOKEN}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`http://127.0.0.1:${EDGE_PORT}${pathname}`, {
    ...init,
    headers
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { response, json };
}

function countHits(mock, predicate) {
  return mock.hits.filter(predicate).length;
}

const primary = createMockServer('primary', PRIMARY_PORT);
const secondary = createMockServer('secondary', SECONDARY_PORT);
const tempDir = await mkdtemp(path.join(EDGE_DIR, '.integration-'));
const stateDir = path.join(tempDir, 'state');
const configPath = path.join(tempDir, 'wrangler.integration.json');
let worker;

try {
  const config = {
    name: 'new-api-cf-edge-api-integration',
    main: path.join(EDGE_DIR, 'src/index.ts'),
    compatibility_date: '2026-04-04',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'new-api-cf-control-integration',
        database_id: '00000000-0000-0000-0000-000000000000',
        preview_database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: path.join(EDGE_DIR, 'migrations'),
        remote: false
      }
    ],
    vars: {
      ENVIRONMENT: 'development',
      APP_NAME: 'new-api-cf',
      AUTH_MODE: 'bearer',
      ADMIN_BEARER_TOKEN: ADMIN_TOKEN,
      UPSTREAM_PROFILES_JSON: JSON.stringify([
        { id: 'primary', label: 'Primary', baseUrl: `http://127.0.0.1:${PRIMARY_PORT}`, apiKey: 'primary-key', providerName: 'primary', modelAllowlist: ['primary-model'] },
        { id: 'secondary', label: 'Secondary', baseUrl: `http://127.0.0.1:${SECONDARY_PORT}`, apiKey: 'secondary-key', providerName: 'secondary', modelAllowlist: ['secondary-model'] }
      ]),
      UPSTREAM_DEFAULT_PROFILE_ID: 'primary'
    }
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await runCommand('bunx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir, '-c', configPath], { cwd: EDGE_DIR });
  await primary.start();
  await secondary.start();

  worker = spawn('bunx', ['wrangler', 'dev', '--local', '--port', String(EDGE_PORT), '--persist-to', stateDir, '-c', configPath], {
    cwd: EDGE_DIR,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  worker.stdout.on('data', (chunk) => process.stdout.write(String(chunk)));
  worker.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));

  await waitForWorker(`http://127.0.0.1:${EDGE_PORT}/api/status`);

  const status = await requestJson('/api/status');
  assert(status.response.ok, 'status endpoint should be available');

  const bootstrap = await requestJson('/api/admin/bootstrap', { method: 'POST' });
  assert(bootstrap.response.ok, 'control plane bootstrap should succeed');

  const listAssistants = await requestJson('/v1/assistants?limit=1&order=desc');
  assert(listAssistants.response.ok, 'assistant list should succeed');
  assert(Array.isArray(listAssistants.json.data), 'assistant list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/assistants' && hit.method === 'GET' && hit.search === '?limit=1&order=desc' && hit.openaiBeta === 'assistants=v2') === 1, 'assistant list should hit default profile with beta header and query string');

  primary.clear();
  secondary.clear();

  const createdAssistant = await requestJson('/v1/assistants', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', name: 'secondary assistant' })
  });
  assert(createdAssistant.response.ok, 'assistant creation should succeed');
  assert(createdAssistant.json.id === 'asst_secondary', 'assistant should be created on secondary upstream');
  assert(countHits(primary, (hit) => hit.path === '/assistants') === 0, 'primary must not receive assistant creation');
  assert(countHits(secondary, (hit) => hit.path === '/assistants' && hit.openaiBeta === 'assistants=v2') === 1, 'secondary should receive assistant creation with beta header');

  primary.clear();
  secondary.clear();

  const readAssistant = await requestJson('/v1/assistants/asst_secondary');
  assert(readAssistant.response.ok, 'stored assistant should be retrievable');
  assert(countHits(primary, (hit) => hit.path === '/assistants/asst_secondary') === 0, 'stored assistant should not probe primary');
  assert(countHits(secondary, (hit) => hit.path === '/assistants/asst_secondary') === 1, 'stored assistant should read from secondary');

  primary.clear();
  secondary.clear();

  const updatedAssistant = await requestJson('/v1/assistants/asst_secondary', {
    method: 'POST',
    body: JSON.stringify({
      metadata: {
        stage: 'updated'
      }
    })
  });
  assert(updatedAssistant.response.ok, 'stored assistant update should succeed');
  assert(updatedAssistant.json.metadata.stage === 'updated', 'assistant update should preserve JSON payload');
  assert(countHits(primary, (hit) => hit.path === '/assistants/asst_secondary' && hit.method === 'POST') === 0, 'stored assistant update should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/assistants/asst_secondary' && hit.method === 'POST' && hit.body?.metadata?.stage === 'updated' && hit.openaiBeta === 'assistants=v2') === 1, 'stored assistant update should hit secondary with beta header');

  primary.clear();
  secondary.clear();

  const legacyAssistant = await requestJson('/v1/assistants/asst_legacy');
  assert(legacyAssistant.response.ok, 'legacy assistant should be discoverable');
  assert(countHits(primary, (hit) => hit.path === '/assistants/asst_legacy') === 1, 'legacy assistant should probe primary first');
  assert(countHits(secondary, (hit) => hit.path === '/assistants/asst_legacy') === 2, 'legacy assistant should probe then read from secondary');

  primary.clear();
  secondary.clear();

  const legacyAssistantCached = await requestJson('/v1/assistants/asst_legacy');
  assert(legacyAssistantCached.response.ok, 'legacy assistant should remain retrievable');
  assert(countHits(primary, (hit) => hit.path === '/assistants/asst_legacy') === 0, 'cached legacy assistant should not probe primary again');
  assert(countHits(secondary, (hit) => hit.path === '/assistants/asst_legacy') === 1, 'cached legacy assistant should go directly to secondary');

  primary.clear();
  secondary.clear();

  const createdThread = await requestJson('/v1/threads', {
    method: 'POST',
    body: JSON.stringify({ metadata: { case: 'primary-thread' } })
  });
  assert(createdThread.response.ok, 'thread creation should succeed');
  assert(createdThread.json.id === 'thread_primary', 'default thread should be created on primary');
  assert(countHits(primary, (hit) => hit.path === '/threads') === 1, 'primary should receive direct thread creation');

  primary.clear();
  secondary.clear();

  const threadAndRun = await requestJson('/v1/threads/runs', {
    method: 'POST',
    body: JSON.stringify({ assistant_id: 'asst_secondary' })
  });
  assert(threadAndRun.response.ok, 'thread and run creation should succeed');
  assert(threadAndRun.json.thread_id === 'thread_secondary', 'thread and run should use assistant upstream');
  assert(countHits(primary, (hit) => hit.path === '/threads/runs') === 0, 'primary must not receive secondary thread+run');
  assert(countHits(secondary, (hit) => hit.path === '/threads/runs') === 1, 'secondary should receive thread+run');

  primary.clear();
  secondary.clear();

  const readThread = await requestJson('/v1/threads/thread_secondary');
  assert(readThread.response.ok, 'thread returned by threads/runs should be retrievable');
  assert(countHits(primary, (hit) => hit.path === '/threads/thread_secondary') === 0, 'stored secondary thread should not probe primary');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary') === 1, 'stored secondary thread should read from secondary');

  primary.clear();
  secondary.clear();

  const mismatch = await requestJson('/v1/threads/thread_primary/runs', {
    method: 'POST',
    body: JSON.stringify({ assistant_id: 'asst_secondary' })
  });
  assert(mismatch.response.status === 409, 'mismatch run should fail with 409');
  assert(mismatch.json.error.code === 'THREAD_ASSISTANT_PROFILE_MISMATCH', 'mismatch should return explicit error code');
  assert(countHits(primary, (hit) => hit.path === '/threads/thread_primary/runs') === 0, 'mismatch should fail before reaching primary upstream');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_primary/runs') === 0, 'mismatch should fail before reaching secondary upstream');

  primary.clear();
  secondary.clear();

  const deleteAssistant = await requestJson('/v1/assistants/asst_secondary', { method: 'DELETE' });
  assert(deleteAssistant.response.ok, 'stored assistant delete should succeed');
  assert(deleteAssistant.json.deleted === true, 'assistant delete should return deleted flag');
  assert(countHits(primary, (hit) => hit.path === '/assistants/asst_secondary' && hit.method === 'DELETE') === 0, 'stored assistant delete should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/assistants/asst_secondary' && hit.method === 'DELETE' && hit.openaiBeta === 'assistants=v2') === 1, 'stored assistant delete should hit secondary with beta header');

  primary.clear();
  secondary.clear();

  const deletedAssistantRead = await requestJson('/v1/assistants/asst_secondary');
  assert(deletedAssistantRead.response.ok, 'assistant should still be readable if upstream object still exists');
  assert(countHits(primary, (hit) => hit.path === '/assistants/asst_secondary' && hit.method === 'GET') === 1, 'assistant read after delete should probe primary once after registry removal');
  assert(countHits(secondary, (hit) => hit.path === '/assistants/asst_secondary' && hit.method === 'GET') === 2, 'assistant read after delete should rediscover and reread secondary after registry removal');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'assistant utility routes preserve beta header and query string',
      'assistant affinity persistence',
      'assistant update and delete follow stored profile registry',
      'legacy assistant upstream discovery cache',
      'thread affinity persistence after threads/runs',
      'thread/assistant profile mismatch gate'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
