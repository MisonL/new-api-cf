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
  if (init.body && !headers.has('content-type') && !(init.body instanceof FormData)) {
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
    name: 'new-api-cf-edge-api-responses-integration',
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
  const bootstrap = await request('/api/admin/bootstrap', { method: 'POST' });
  assert(bootstrap.response.ok, 'control plane bootstrap should succeed');

  const inputTokensDefault = await request('/v1/responses/input_tokens', {
    method: 'POST',
    body: JSON.stringify({ ttl_seconds: 60 })
  });
  assert(inputTokensDefault.response.ok, 'response input_tokens without model should succeed');
  assert(inputTokensDefault.json.data[0]?.token === 'token_primary', 'response input_tokens without model should use default upstream');
  assert(countHits(primary, (hit) => hit.path === '/responses/input_tokens' && hit.method === 'POST' && hit.body?.ttl_seconds === 60) === 1, 'response input_tokens without model should preserve JSON payload on default upstream');
  assert(countHits(secondary, (hit) => hit.path === '/responses/input_tokens') === 0, 'response input_tokens without model should not hit secondary');

  primary.clear();
  secondary.clear();

  const inputTokensModeled = await request('/v1/responses/input_tokens', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', ttl_seconds: 120 })
  });
  assert(inputTokensModeled.response.ok, 'response input_tokens with model should succeed');
  assert(inputTokensModeled.json.data[0]?.token === 'token_secondary', 'response input_tokens with model should route by model');
  assert(countHits(primary, (hit) => hit.path === '/responses/input_tokens') === 0, 'response input_tokens with model should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses/input_tokens' && hit.method === 'POST' && hit.body?.ttl_seconds === 120 && hit.body?.model === 'secondary-model') === 1, 'response input_tokens with model should preserve JSON payload on resolved upstream');

  primary.clear();
  secondary.clear();

  const compact = await request('/v1/responses/compact', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', response_id: 'resp_secondary' })
  });
  assert(compact.response.ok, 'response compact should succeed');
  assert(compact.json.compacted === true, 'response compact should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/responses/compact') === 0, 'response compact should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses/compact' && hit.method === 'POST' && hit.body?.response_id === 'resp_secondary') === 1, 'response compact should preserve JSON payload on resolved upstream');

  primary.clear();
  secondary.clear();

  const created = await request('/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', input: 'hello' })
  });
  assert(created.response.ok, 'response creation should succeed');
  assert(created.json.id === 'resp_secondary', 'response should be created on secondary');
  assert(countHits(primary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 0, 'primary must not receive secondary response create');
  assert(countHits(secondary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 1, 'secondary should receive response create');

  primary.clear();
  secondary.clear();

  const followup = await request('/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', input: 'followup', previous_response_id: 'resp_secondary' })
  });
  assert(followup.response.ok, 'followup response should succeed on stored profile');
  assert(followup.json.id === 'resp_secondary_followup', 'followup response should be created on secondary');
  assert(countHits(primary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 0, 'followup should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 1, 'followup should hit secondary');

  primary.clear();
  secondary.clear();

  const emptyInputFollowup = await request('/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', previous_response_id: 'resp_secondary' })
  });
  assert(emptyInputFollowup.response.ok, 'followup without explicit input should be accepted');
  assert(emptyInputFollowup.json.id === 'resp_secondary_followup', 'followup without explicit input should stay on secondary');
  assert(countHits(primary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 0, 'empty-input followup should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 1, 'empty-input followup should hit secondary');

  primary.clear();
  secondary.clear();

  const mismatch = await request('/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'primary-model', input: 'mismatch', previous_response_id: 'resp_secondary' })
  });
  assert(mismatch.response.status === 409, 'response continuation mismatch should fail with 409');
  assert(mismatch.json.error.code === 'RESPONSE_PREVIOUS_PROFILE_MISMATCH', 'response continuation mismatch should return explicit code');
  assert(countHits(primary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 0, 'mismatch should fail before upstream request');
  assert(countHits(secondary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 0, 'mismatch should fail before upstream request');

  primary.clear();
  secondary.clear();

  const retrieved = await request('/v1/responses/resp_secondary');
  assert(retrieved.response.ok, 'stored response should be retrievable');
  assert(countHits(primary, (hit) => hit.path === '/responses/resp_secondary') === 0, 'stored response should not probe primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses/resp_secondary') === 1, 'stored response should read from secondary');

  primary.clear();
  secondary.clear();

  const inputItems = await request('/v1/responses/resp_secondary/input_items');
  assert(inputItems.response.ok, 'stored response input items should be retrievable');
  assert(countHits(secondary, (hit) => hit.path === '/responses/resp_secondary/input_items') === 1, 'input items should route via stored profile');

  primary.clear();
  secondary.clear();

  const legacy = await request('/v1/responses/resp_legacy');
  assert(legacy.response.ok, 'legacy response should be discoverable');
  assert(countHits(primary, (hit) => hit.path === '/responses/resp_legacy') === 1, 'legacy response should probe primary first');
  assert(countHits(secondary, (hit) => hit.path === '/responses/resp_legacy') === 2, 'legacy response should probe then read from secondary');

  primary.clear();
  secondary.clear();

  const legacyFollowup = await request('/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', input: 'legacy followup', previous_response_id: 'resp_legacy' })
  });
  assert(legacyFollowup.response.ok, 'legacy followup should reuse discovered profile');
  assert(countHits(primary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 0, 'legacy followup should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses' && hit.method === 'POST') === 1, 'legacy followup should hit secondary');

  primary.clear();
  secondary.clear();

  const legacyCancel = await request('/v1/responses/resp_legacy/cancel', { method: 'POST' });
  assert(legacyCancel.response.ok, 'legacy response cancel should use discovered profile');
  assert(countHits(primary, (hit) => hit.path === '/responses/resp_legacy/cancel') === 0, 'legacy cancel should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses/resp_legacy/cancel') === 1, 'legacy cancel should hit secondary');

  primary.clear();
  secondary.clear();

  const deleted = await request('/v1/responses/resp_secondary', { method: 'DELETE' });
  assert(deleted.response.ok, 'stored response delete should succeed');
  assert(countHits(secondary, (hit) => hit.path === '/responses/resp_secondary' && hit.method === 'DELETE') === 1, 'delete should route via stored profile');

  primary.clear();
  secondary.clear();

  const deletedAgain = await request('/v1/responses/resp_secondary', { method: 'DELETE' });
  assert(deletedAgain.response.ok, 'deleted response should still be discoverable through fallback');
  assert(countHits(primary, (hit) => hit.path === '/responses/resp_secondary' && hit.method === 'GET') === 1, 'delete fallback should probe primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses/resp_secondary' && hit.method === 'GET') === 1, 'delete fallback should discover secondary');
  assert(countHits(secondary, (hit) => hit.path === '/responses/resp_secondary' && hit.method === 'DELETE') === 1, 'delete fallback should delete on secondary');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'response input_tokens and compact utility routes preserve upstream selection and payloads',
      'response affinity persistence after create',
      'response continuation uses stored profile',
      'response continuation accepts omitted input',
      'response continuation mismatch is rejected before upstream',
      'response input_items route through stored profile',
      'legacy response upstream discovery cache',
      'legacy response continuation reuses discovered profile',
      'response cancel route through discovered profile',
      'response delete route through stored or discovered profile'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
