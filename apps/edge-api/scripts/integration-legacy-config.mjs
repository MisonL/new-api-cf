#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCommand, stopChild, waitForWorker } from './integration-helpers.mjs';
import { createMockServer } from './mock-openai.mjs';

const PRIMARY_PORT = 18891;
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
  let json = null;
  if (text && (response.headers.get('content-type') || '').includes('application/json')) {
    json = JSON.parse(text);
  }
  return { response, text, json };
}

const primary = createMockServer('primary', PRIMARY_PORT);
const tempDir = await mkdtemp(path.join(EDGE_DIR, '.integration-'));
const stateDir = path.join(tempDir, 'state');
const configPath = path.join(tempDir, 'wrangler.integration.json');
let worker;

try {
  const config = {
    name: 'new-api-cf-edge-api-legacy-config-integration',
    main: path.join(EDGE_DIR, 'src/index.ts'),
    compatibility_date: '2026-04-04',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'new-api-cf-legacy-config-integration',
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
      OPENAI_BASE_URL: `http://127.0.0.1:${PRIMARY_PORT}`,
      OPENAI_API_KEY: 'legacy-key',
      OPENAI_MODEL_ALLOWLIST: 'legacy-model',
      OPENAI_PROVIDER_NAME: 'legacy-provider'
    }
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await runCommand('bunx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir, '-c', configPath], { cwd: EDGE_DIR });
  await primary.start();
  worker = spawn('bunx', ['wrangler', 'dev', '--local', '--port', String(EDGE_PORT), '--persist-to', stateDir, '-c', configPath], {
    cwd: EDGE_DIR,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  worker.stdout.on('data', (chunk) => process.stdout.write(String(chunk)));
  worker.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));

  await waitForWorker(`http://127.0.0.1:${EDGE_PORT}/api/status`);

  const statusBeforeBootstrap = await request('/api/status');
  assert(statusBeforeBootstrap.response.ok, 'status before bootstrap should succeed');
  assert(statusBeforeBootstrap.json.data.upstreamConfigured === true, 'legacy openai env should configure upstream');
  assert(statusBeforeBootstrap.json.data.modelCount === 0, 'status before bootstrap should report empty D1 model catalog');

  const bootstrap = await request('/api/admin/bootstrap', { method: 'POST' });
  assert(bootstrap.response.ok, 'bootstrap should succeed with legacy openai env');
  assert(Array.isArray(bootstrap.json.data.models) && bootstrap.json.data.models.length === 1, 'bootstrap should seed one legacy model');
  assert(bootstrap.json.data.models[0].id === 'legacy-model', 'bootstrap should seed legacy model id');
  assert(bootstrap.json.data.profiles.length === 1, 'bootstrap should expose one legacy upstream profile');
  assert(bootstrap.json.data.profiles[0].id === 'default', 'legacy upstream profile id should default to default');
  assert(bootstrap.json.data.profiles[0].providerName === 'legacy-provider', 'legacy upstream profile should preserve provider name');

  const adminState = await request('/api/admin/state');
  assert(adminState.response.ok, 'admin state should succeed');
  assert(adminState.json.data.models.length === 1, 'admin state should persist one legacy model');
  assert(adminState.json.data.profiles[0].supportedModelIds.includes('legacy-model'), 'admin state profile should carry legacy model allowlist');

  const publicModels = await request('/api/models');
  assert(publicModels.response.ok, 'public model catalog should succeed');
  assert(publicModels.json.data.data.length === 1, 'public model catalog should expose legacy model');
  assert(publicModels.json.data.data[0].id === 'legacy-model', 'public model catalog should preserve legacy model id');

  primary.clear();

  const chat = await request('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'legacy-model',
      messages: [{ role: 'user', content: 'hello legacy config' }]
    })
  });
  assert(chat.response.ok, 'chat completion should succeed with legacy openai config');
  assert(chat.json.choices[0].message.content === 'chat-primary', 'chat completion should return primary mock payload');
  assert(primary.hits.filter((hit) => hit.path === '/chat/completions').length === 1, 'chat completion should hit legacy upstream');
  assert(primary.hits[0].authorization === 'Bearer legacy-key', 'chat completion should use legacy upstream api key');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'legacy OPENAI env vars bootstrap a default upstream profile',
      'legacy config seeds model catalog through control plane bootstrap',
      'api and relay routes continue to work without UPSTREAM_PROFILES_JSON'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
