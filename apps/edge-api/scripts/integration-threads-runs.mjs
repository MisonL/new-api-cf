#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCommand, stopChild, waitForWorker } from './integration-helpers.mjs';
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
    name: 'new-api-cf-edge-api-threads-runs-integration',
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

  const bootstrap = await request('/api/admin/bootstrap', {
    method: 'POST'
  });
  assert(bootstrap.response.ok, 'control plane bootstrap should succeed');

  const createAssistant = await request('/v1/assistants', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', name: 'secondary assistant' })
  });
  assert(createAssistant.response.ok, 'assistant creation should succeed');
  assert(createAssistant.json.id === 'asst_secondary', 'assistant should be created on secondary upstream');

  primary.clear();
  secondary.clear();

  const createThreadAndRun = await request('/v1/threads/runs', {
    method: 'POST',
    body: JSON.stringify({ assistant_id: 'asst_secondary' })
  });
  assert(createThreadAndRun.response.ok, 'thread and run creation should succeed');
  assert(createThreadAndRun.json.thread_id === 'thread_secondary', 'thread and run should create a secondary thread');
  assert(countHits(secondary, (hit) => hit.path === '/threads/runs' && hit.openaiBeta === 'assistants=v2') === 1, 'thread and run should hit secondary with beta header');

  primary.clear();
  secondary.clear();

  const readThread = await request('/v1/threads/thread_secondary');
  assert(readThread.response.ok, 'thread detail should succeed');
  assert(readThread.json.id === 'thread_secondary', 'thread detail should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/threads/thread_secondary') === 0, 'stored thread should not probe primary');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary' && hit.method === 'GET') === 1, 'stored thread should read from secondary');

  primary.clear();
  secondary.clear();

  const updateThread = await request('/v1/threads/thread_secondary', {
    method: 'POST',
    body: JSON.stringify({
      metadata: {
        updated: 'true'
      }
    })
  });
  assert(updateThread.response.ok, 'thread update should succeed');
  assert(updateThread.json.metadata.updated === 'true', 'thread update should preserve JSON body');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary' && hit.method === 'POST' && hit.openaiBeta === 'assistants=v2') === 1, 'thread update should hit secondary with beta header');

  primary.clear();
  secondary.clear();

  const createMessage = await request('/v1/threads/thread_secondary/messages', {
    method: 'POST',
    body: JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text: 'hello from integration' }]
    })
  });
  assert(createMessage.response.ok, 'thread message create should succeed');
  assert(createMessage.json.id === 'msg_secondary', 'thread message create should preserve upstream payload');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/messages' && hit.method === 'POST' && hit.openaiBeta === 'assistants=v2') === 1, 'thread message create should hit secondary with beta header');

  primary.clear();
  secondary.clear();

  const listMessages = await request('/v1/threads/thread_secondary/messages?limit=2&order=desc');
  assert(listMessages.response.ok, 'thread message list should succeed');
  assert(Array.isArray(listMessages.json.data), 'thread message list should return list data');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/messages' && hit.method === 'GET' && hit.search === '?limit=2&order=desc') === 1, 'thread message list should preserve query string');

  primary.clear();
  secondary.clear();

  const readMessage = await request('/v1/threads/thread_secondary/messages/msg_secondary');
  assert(readMessage.response.ok, 'thread message detail should succeed');
  assert(readMessage.json.id === 'msg_secondary', 'thread message detail should preserve upstream payload');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/messages/msg_secondary' && hit.method === 'GET') === 1, 'thread message detail should hit secondary');

  primary.clear();
  secondary.clear();

  const updateMessage = await request('/v1/threads/thread_secondary/messages/msg_secondary', {
    method: 'POST',
    body: JSON.stringify({
      metadata: {
        status: 'reviewed'
      }
    })
  });
  assert(updateMessage.response.ok, 'thread message update should succeed');
  assert(updateMessage.json.metadata.status === 'reviewed', 'thread message update should preserve JSON body');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/messages/msg_secondary' && hit.method === 'POST' && hit.openaiBeta === 'assistants=v2') === 1, 'thread message update should hit secondary with beta header');

  primary.clear();
  secondary.clear();

  const deleteMessage = await request('/v1/threads/thread_secondary/messages/msg_secondary', {
    method: 'DELETE'
  });
  assert(deleteMessage.response.ok, 'thread message delete should succeed');
  assert(deleteMessage.json.deleted === true, 'thread message delete should return deleted flag');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/messages/msg_secondary' && hit.method === 'DELETE') === 1, 'thread message delete should hit secondary');

  primary.clear();
  secondary.clear();

  const listRuns = await request('/v1/threads/thread_secondary/runs?limit=10');
  assert(listRuns.response.ok, 'thread run list should succeed');
  assert(Array.isArray(listRuns.json.data), 'thread run list should return list data');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/runs' && hit.method === 'GET' && hit.search === '?limit=10') === 1, 'thread run list should preserve query string');

  primary.clear();
  secondary.clear();

  const readRun = await request('/v1/threads/thread_secondary/runs/run_secondary_followup?include=steps');
  assert(readRun.response.ok, 'thread run detail should succeed');
  assert(readRun.json.id === 'run_secondary_followup', 'thread run detail should preserve upstream payload');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/runs/run_secondary_followup' && hit.method === 'GET' && hit.search === '?include=steps') === 1, 'thread run detail should preserve query string');

  primary.clear();
  secondary.clear();

  const cancelRun = await request('/v1/threads/thread_secondary/runs/run_secondary_followup/cancel', {
    method: 'POST'
  });
  assert(cancelRun.response.ok, 'thread run cancel should succeed');
  assert(cancelRun.json.status === 'cancelling', 'thread run cancel should preserve upstream payload');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/runs/run_secondary_followup/cancel' && hit.method === 'POST') === 1, 'thread run cancel should hit secondary');

  primary.clear();
  secondary.clear();

  const submitToolOutputs = await request('/v1/threads/thread_secondary/runs/run_secondary_followup/submit_tool_outputs', {
    method: 'POST',
    body: JSON.stringify({
      tool_outputs: [{ tool_call_id: 'call_1', output: 'done' }]
    })
  });
  assert(submitToolOutputs.response.ok, 'thread submit tool outputs should succeed');
  assert(submitToolOutputs.json.status === 'queued', 'thread submit tool outputs should preserve upstream payload');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/runs/run_secondary_followup/submit_tool_outputs' && hit.method === 'POST' && hit.openaiBeta === 'assistants=v2') === 1, 'thread submit tool outputs should hit secondary with beta header');

  primary.clear();
  secondary.clear();

  const listSteps = await request('/v1/threads/thread_secondary/runs/run_secondary_followup/steps?include=step_details');
  assert(listSteps.response.ok, 'thread run steps list should succeed');
  assert(Array.isArray(listSteps.json.data), 'thread run steps list should return list data');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/runs/run_secondary_followup/steps' && hit.method === 'GET' && hit.search === '?include=step_details') === 1, 'thread run steps list should preserve query string');

  primary.clear();
  secondary.clear();

  const readStep = await request('/v1/threads/thread_secondary/runs/run_secondary_followup/steps/step_secondary');
  assert(readStep.response.ok, 'thread run step detail should succeed');
  assert(readStep.json.id === 'step_secondary', 'thread run step detail should preserve upstream payload');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary/runs/run_secondary_followup/steps/step_secondary' && hit.method === 'GET') === 1, 'thread run step detail should hit secondary');

  primary.clear();
  secondary.clear();

  const legacyMessages = await request('/v1/threads/thread_legacy/messages?limit=1');
  assert(legacyMessages.response.ok, 'legacy thread message list should succeed through discovery');
  assert(countHits(primary, (hit) => hit.path === '/threads/thread_legacy' && hit.method === 'GET') === 1, 'legacy thread should probe primary once during discovery');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_legacy' && hit.method === 'GET') === 1, 'legacy thread should probe secondary during discovery');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_legacy/messages' && hit.method === 'GET' && hit.search === '?limit=1') === 1, 'legacy thread message list should route to discovered secondary profile');

  primary.clear();
  secondary.clear();

  const legacyRuns = await request('/v1/threads/thread_legacy/runs?limit=1');
  assert(legacyRuns.response.ok, 'cached legacy thread run list should succeed');
  assert(countHits(primary, (hit) => hit.path === '/threads/thread_legacy' && hit.method === 'GET') === 0, 'cached legacy thread should not probe primary again');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_legacy' && hit.method === 'GET') === 0, 'cached legacy thread should not re-probe secondary');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_legacy/runs' && hit.method === 'GET' && hit.search === '?limit=1') === 1, 'cached legacy thread run list should use stored secondary profile');

  primary.clear();
  secondary.clear();

  const deleteThread = await request('/v1/threads/thread_secondary', {
    method: 'DELETE'
  });
  assert(deleteThread.response.ok, 'thread delete should succeed');
  assert(deleteThread.json.deleted === true, 'thread delete should return deleted flag');
  assert(countHits(secondary, (hit) => hit.path === '/threads/thread_secondary' && hit.method === 'DELETE') === 1, 'thread delete should hit secondary');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'thread detail and update stay on stored upstream profile',
      'thread message CRUD routes preserve beta header and query string passthrough',
      'thread run utility routes preserve beta header and query string passthrough',
      'legacy thread discovery cache is reused by message and run routes'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
