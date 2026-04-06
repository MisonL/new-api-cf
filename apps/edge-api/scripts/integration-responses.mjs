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
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(3000)
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));
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
    stdio: ['ignore', 'pipe', 'pipe']
  });
  worker.stdout.on('data', (chunk) => process.stdout.write(String(chunk)));
  worker.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));

  await waitForWorker(`http://127.0.0.1:${EDGE_PORT}/api/status`);
  const bootstrap = await request('/api/admin/bootstrap', { method: 'POST' });
  assert(bootstrap.response.ok, 'control plane bootstrap should succeed');

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
      'response affinity persistence after create',
      'response input_items route through stored profile',
      'legacy response upstream discovery cache',
      'response cancel route through discovered profile',
      'response delete route through stored or discovered profile'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
