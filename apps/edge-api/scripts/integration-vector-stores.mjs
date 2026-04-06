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

async function request(pathname, init = {}) {
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
  let json = null;
  if (text && (response.headers.get('content-type') || '').includes('application/json')) {
    json = JSON.parse(text);
  }
  return { response, json, text };
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
    name: 'new-api-cf-edge-api-vector-store-integration',
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

  const listStores = await request('/v1/vector_stores?limit=1');
  assert(listStores.response.ok, 'vector store list should succeed');
  assert(Array.isArray(listStores.json.data), 'vector store list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores' && hit.method === 'GET' && hit.search === '?limit=1' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store list should hit primary with beta header and preserve query string');

  primary.clear();
  secondary.clear();

  const createStore = await request('/v1/vector_stores', {
    method: 'POST',
    body: JSON.stringify({ name: 'kb-primary' })
  });
  assert(createStore.response.ok, 'vector store creation should succeed');
  assert(createStore.json.id === 'vs_primary', 'vector store should be created on default upstream');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store create should hit primary with beta header');
  assert(countHits(secondary, (hit) => hit.path === '/vector_stores') === 0, 'vector store create should not hit secondary');

  primary.clear();
  secondary.clear();

  const readStore = await request('/v1/vector_stores/vs_primary');
  assert(readStore.response.ok, 'vector store detail should succeed');
  assert(readStore.json.id === 'vs_primary', 'vector store detail should preserve upstream payload');
  assert(readStore.json.metadata.source === 'primary', 'vector store detail should preserve upstream metadata');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary' && hit.method === 'GET' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store detail should hit primary with beta header');

  primary.clear();
  secondary.clear();

  const updateStore = await request('/v1/vector_stores/vs_primary', {
    method: 'POST',
    body: JSON.stringify({
      name: 'kb-primary-updated',
      metadata: {
        scope: 'integration'
      }
    })
  });
  assert(updateStore.response.ok, 'vector store update should succeed');
  assert(updateStore.json.metadata.scope === 'integration', 'vector store update should preserve JSON payload');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary' && hit.method === 'POST' && hit.body?.metadata?.scope === 'integration' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store update should hit primary with beta header and request payload');

  primary.clear();
  secondary.clear();

  const search = await request('/v1/vector_stores/vs_primary/search', {
    method: 'POST',
    body: JSON.stringify({ query: 'hello' })
  });
  assert(search.response.ok, 'vector store search should succeed');
  assert(Array.isArray(search.json.data), 'vector store search should return list data');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/search' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store search should hit primary with beta header');
  assert(countHits(secondary, (hit) => hit.path === '/vector_stores/vs_primary/search') === 0, 'vector store search should not hit secondary');

  primary.clear();
  secondary.clear();

  const listFiles = await request('/v1/vector_stores/vs_primary/files?limit=2');
  assert(listFiles.response.ok, 'vector store file list should succeed');
  assert(Array.isArray(listFiles.json.data), 'vector store file list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/files' && hit.method === 'GET' && hit.search === '?limit=2' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store file list should hit primary with beta header and preserve query string');

  primary.clear();
  secondary.clear();

  const attachFile = await request('/v1/vector_stores/vs_primary/files', {
    method: 'POST',
    body: JSON.stringify({ file_id: 'file_123' })
  });
  assert(attachFile.response.ok, 'vector store file attach should succeed');
  assert(attachFile.json.id === 'vsfile_primary', 'vector store file should be created on default upstream');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/files' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store file attach should hit primary with beta header');

  primary.clear();
  secondary.clear();

  const readFile = await request('/v1/vector_stores/vs_primary/files/vsfile_primary');
  assert(readFile.response.ok, 'vector store file detail should succeed');
  assert(readFile.json.id === 'vsfile_primary', 'vector store file detail should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/files/vsfile_primary' && hit.method === 'GET' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store file detail should hit primary with beta header');

  primary.clear();
  secondary.clear();

  const readFileContent = await request('/v1/vector_stores/vs_primary/files/vsfile_primary/content?format=text');
  assert(readFileContent.response.ok, 'vector store file content should succeed');
  assert(readFileContent.text === 'vector-store-file-content-primary', 'vector store file content should preserve raw upstream response');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/files/vsfile_primary/content' && hit.method === 'GET' && hit.search === '?format=text' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store file content should hit primary with beta header and preserve query string');

  primary.clear();
  secondary.clear();

  const updateFile = await request('/v1/vector_stores/vs_primary/files/vsfile_primary', {
    method: 'POST',
    body: JSON.stringify({
      attributes: {
        stage: 'verified'
      }
    })
  });
  assert(updateFile.response.ok, 'vector store file update should succeed');
  assert(updateFile.json.attributes.stage === 'verified', 'vector store file update should preserve JSON payload');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/files/vsfile_primary' && hit.method === 'POST' && hit.body?.attributes?.stage === 'verified' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store file update should hit primary with beta header and request payload');

  primary.clear();
  secondary.clear();

  const deleteFile = await request('/v1/vector_stores/vs_primary/files/vsfile_primary', { method: 'DELETE' });
  assert(deleteFile.response.ok, 'vector store file delete should succeed');
  assert(deleteFile.json.deleted === true, 'vector store file delete should return deleted flag');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/files/vsfile_primary' && hit.method === 'DELETE' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store file delete should hit primary with beta header');

  primary.clear();
  secondary.clear();

  const listBatches = await request('/v1/vector_stores/vs_primary/file_batches?limit=1');
  assert(listBatches.response.ok, 'vector store file batch list should succeed');
  assert(Array.isArray(listBatches.json.data), 'vector store file batch list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/file_batches' && hit.method === 'GET' && hit.search === '?limit=1' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store file batch list should hit primary with beta header and preserve query string');

  primary.clear();
  secondary.clear();

  const createBatch = await request('/v1/vector_stores/vs_primary/file_batches', {
    method: 'POST',
    body: JSON.stringify({ file_ids: ['file_123'] })
  });
  assert(createBatch.response.ok, 'vector store file batch creation should succeed');
  assert(createBatch.json.id === 'vsbatch_primary', 'vector store file batch should be created on default upstream');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/file_batches' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store batch create should hit primary with beta header');

  primary.clear();
  secondary.clear();

  const readBatch = await request('/v1/vector_stores/vs_primary/file_batches/vsbatch_primary');
  assert(readBatch.response.ok, 'vector store file batch detail should succeed');
  assert(readBatch.json.id === 'vsbatch_primary', 'vector store file batch detail should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/file_batches/vsbatch_primary' && hit.method === 'GET' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store file batch detail should hit primary with beta header');

  primary.clear();
  secondary.clear();

  const listBatchFiles = await request('/v1/vector_stores/vs_primary/file_batches/vsbatch_primary/files?limit=2');
  assert(listBatchFiles.response.ok, 'vector store file batch list should succeed');
  assert(Array.isArray(listBatchFiles.json.data), 'vector store file batch list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/file_batches/vsbatch_primary/files' && hit.method === 'GET' && hit.search === '?limit=2' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store batch file list should hit primary with beta header and preserve query string');

  primary.clear();
  secondary.clear();

  const cancelBatch = await request('/v1/vector_stores/vs_primary/file_batches/vsbatch_primary/cancel', { method: 'POST' });
  assert(cancelBatch.response.ok, 'vector store file batch cancel should succeed');
  assert(cancelBatch.json.status === 'cancelled', 'vector store file batch cancel should return cancelled status');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary/file_batches/vsbatch_primary/cancel' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store batch cancel should hit primary with beta header');

  primary.clear();
  secondary.clear();

  const deleteStore = await request('/v1/vector_stores/vs_primary', { method: 'DELETE' });
  assert(deleteStore.response.ok, 'vector store delete should succeed');
  assert(deleteStore.json.deleted === true, 'vector store delete should return deleted flag');
  assert(countHits(primary, (hit) => hit.path === '/vector_stores/vs_primary' && hit.method === 'DELETE' && hit.openaiBeta === 'assistants=v2') === 1, 'vector store delete should hit primary with beta header');
  assert(countHits(secondary, (hit) => hit.path.startsWith('/vector_stores/')) === 0, 'vector store utility routes should not hit secondary');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'vector store utility routes use default upstream profile',
      'vector store utility routes include assistants beta header',
      'vector store detail and update routes preserve JSON payloads',
      'vector store file routes preserve query strings and raw content passthrough',
      'vector store file and file batch routes stay on default upstream'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
