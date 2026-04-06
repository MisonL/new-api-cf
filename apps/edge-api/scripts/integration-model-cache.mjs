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
const SESSION_SECRET = 'session-secret-012345678901234567';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EDGE_DIR = path.resolve(SCRIPT_DIR, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (init.cookie) {
    headers.set('cookie', init.cookie);
  }
  if (init.bearerToken) {
    headers.set('authorization', `Bearer ${init.bearerToken}`);
  }

  const response = await fetch(`http://127.0.0.1:${EDGE_PORT}${pathname}`, {
    method: init.method || 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body
  });
  const text = await response.text();
  let json = null;
  if (text && (response.headers.get('content-type') || '').includes('application/json')) {
    json = JSON.parse(text);
  }
  return {
    response,
    json,
    text,
    setCookie: response.headers.get('set-cookie')
  };
}

function readCookie(setCookie) {
  return setCookie ? setCookie.split(';', 1)[0] : '';
}

const primary = createMockServer('primary', PRIMARY_PORT);
const tempDir = await mkdtemp(path.join(EDGE_DIR, '.integration-'));
const stateDir = path.join(tempDir, 'state');
const configPath = path.join(tempDir, 'wrangler.integration.json');
let worker;

try {
  const config = {
    name: 'new-api-cf-edge-api-model-cache-integration',
    main: path.join(EDGE_DIR, 'src/index.ts'),
    compatibility_date: '2026-04-04',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'new-api-cf-model-cache-integration',
        database_id: '00000000-0000-0000-0000-000000000000',
        preview_database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: path.join(EDGE_DIR, 'migrations'),
        remote: false
      }
    ],
    kv_namespaces: [
      {
        binding: 'MODEL_CATALOG_CACHE',
        id: '00000000000000000000000000000000',
        preview_id: '00000000000000000000000000000000'
      }
    ],
    vars: {
      ENVIRONMENT: 'development',
      APP_NAME: 'new-api-cf',
      AUTH_MODE: 'session',
      ADMIN_BEARER_TOKEN: ADMIN_TOKEN,
      SESSION_SECRET,
      UPSTREAM_PROFILES_JSON: JSON.stringify([
        {
          id: 'primary',
          label: 'Primary',
          baseUrl: `http://127.0.0.1:${PRIMARY_PORT}`,
          apiKey: 'primary-key',
          providerName: 'primary',
          modelAllowlist: ['primary-model', 'secondary-model']
        }
      ]),
      UPSTREAM_DEFAULT_PROFILE_ID: 'primary'
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
  assert(statusBeforeBootstrap.json.data.kvConfigured === true, 'status should report kv binding');
  assert(statusBeforeBootstrap.json.data.modelCount === 0, 'status before bootstrap should report empty model catalog');

  const login = await request('/api/auth/login', {
    method: 'POST',
    json: { token: ADMIN_TOKEN }
  });
  assert(login.response.ok, 'login should succeed');
  const sessionCookie = readCookie(login.setCookie);
  assert(sessionCookie.length > 0, 'login should issue session cookie');

  const bootstrap = await request('/api/admin/bootstrap', {
    method: 'POST',
    cookie: sessionCookie
  });
  assert(bootstrap.response.ok, 'control plane bootstrap should succeed');
  assert(bootstrap.json.data.models.length === 2, 'bootstrap should seed both models');

  const updateModel = await request('/api/admin/models/secondary-model', {
    method: 'PATCH',
    cookie: sessionCookie,
    json: {
      label: 'Secondary Model',
      enabled: false,
      upstreamProfileId: 'primary'
    }
  });
  assert(updateModel.response.ok, 'model update should succeed');

  const publicModelsBeforeDelete = await request('/api/models');
  assert(publicModelsBeforeDelete.response.ok, 'public model catalog should succeed before D1 delete');
  assert(publicModelsBeforeDelete.json.data.data.length === 1, 'public model catalog should reflect refreshed cache');
  assert(publicModelsBeforeDelete.json.data.data[0].id === 'primary-model', 'only primary-model should remain enabled');

  const createToken = await request('/api/admin/tokens', {
    method: 'POST',
    cookie: sessionCookie,
    json: {
      name: 'model-cache smoke'
    }
  });
  assert(createToken.response.ok, 'api token creation should succeed');
  const apiToken = createToken.json.data.token;

  await runCommand('bunx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', stateDir, '--command', 'DELETE FROM relay_models;', '-c', configPath], {
    cwd: EDGE_DIR
  });

  const adminStateAfterDelete = await request('/api/admin/state', {
    cookie: sessionCookie
  });
  assert(adminStateAfterDelete.response.ok, 'admin state after D1 delete should succeed');
  assert(adminStateAfterDelete.json.data.models.length === 0, 'admin state should confirm relay_models rows were deleted from D1');

  const statusAfterDelete = await request('/api/status');
  assert(statusAfterDelete.response.ok, 'status after D1 delete should succeed');
  assert(statusAfterDelete.json.data.modelCount === 1, 'status should still report cached model count');

  const publicModelsAfterDelete = await request('/api/models');
  assert(publicModelsAfterDelete.response.ok, 'public model catalog should succeed after D1 delete');
  assert(publicModelsAfterDelete.json.data.data.length === 1, 'public model catalog should still come from KV cache after D1 delete');
  assert(publicModelsAfterDelete.json.data.data[0].id === 'primary-model', 'cached public model should remain primary-model');

  const relayModelsAfterDelete = await request('/v1/models', {
    bearerToken: apiToken
  });
  assert(relayModelsAfterDelete.response.ok, 'relay model catalog should still succeed after D1 delete');
  assert(relayModelsAfterDelete.json.data.length === 1, 'relay model catalog should use cached model snapshot');

  const missingDisabledModel = await request('/v1/models/secondary-model', {
    bearerToken: apiToken
  });
  assert(missingDisabledModel.response.status === 404, 'disabled secondary model should stay unavailable from cached snapshot');
  assert(missingDisabledModel.json.error.code === 'MODEL_NOT_FOUND', 'disabled model should return explicit error code');

  primary.clear();

  const chat = await request('/v1/chat/completions', {
    method: 'POST',
    bearerToken: apiToken,
    json: {
      model: 'primary-model',
      messages: [{ role: 'user', content: 'hello cached model catalog' }]
    }
  });
  assert(chat.response.ok, 'chat completion should still succeed with cached model catalog');
  assert(chat.json.choices[0].message.content === 'chat-primary', 'chat completion should preserve upstream payload');
  assert(primary.hits.filter((hit) => hit.path === '/chat/completions').length === 1, 'chat completion should still route through primary upstream');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'status endpoint reports kv model cache binding',
      'bootstrap and model update refresh the kv model snapshot',
      'api and relay model catalog reads survive relay_models deletion by reusing kv cache',
      'relay requests still authorize and route with cached model catalog'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
