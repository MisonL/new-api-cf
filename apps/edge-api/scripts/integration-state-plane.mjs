#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
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

async function waitForUsageRow(cookie, predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const usage = await request('/api/admin/usage?days=1', {
      cookie
    });
    if (usage.response.ok) {
      const row = usage.json.data.rows.find(predicate);
      if (row) {
        return {
          usage: usage.json.data,
          row
        };
      }
    }
    await delay(500);
  }

  throw new Error('usage row did not appear via queue consumer');
}

const primary = createMockServer('primary', PRIMARY_PORT);
const tempDir = await mkdtemp(path.join(EDGE_DIR, '.integration-'));
const stateDir = path.join(tempDir, 'state');
const configPath = path.join(tempDir, 'wrangler.integration.json');
let worker;

try {
  const config = {
    name: 'new-api-cf-edge-api-state-plane-integration',
    main: path.join(EDGE_DIR, 'src/index.ts'),
    compatibility_date: '2026-04-04',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'new-api-cf-state-plane-integration',
        database_id: '00000000-0000-0000-0000-000000000000',
        preview_database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: path.join(EDGE_DIR, 'migrations'),
        remote: false
      }
    ],
    durable_objects: {
      bindings: [
        {
          name: 'RELAY_LIMITER',
          class_name: 'RelayRateLimiterDO'
        }
      ]
    },
    migrations: [
      {
        tag: 'v1',
        new_sqlite_classes: ['RelayRateLimiterDO']
      }
    ],
    queues: {
      producers: [
        {
          binding: 'USAGE_EVENTS',
          queue: 'usage-events'
        }
      ],
      consumers: [
        {
          queue: 'usage-events',
          max_batch_size: 10,
          max_batch_timeout: 1,
          max_retries: 1
        }
      ]
    },
    vars: {
      ENVIRONMENT: 'development',
      APP_NAME: 'new-api-cf',
      AUTH_MODE: 'session',
      ADMIN_BEARER_TOKEN: ADMIN_TOKEN,
      SESSION_SECRET,
      RELAY_RATE_LIMIT_PER_MINUTE: '1',
      UPSTREAM_PROFILES_JSON: JSON.stringify([
        { id: 'primary', label: 'Primary', baseUrl: `http://127.0.0.1:${PRIMARY_PORT}`, apiKey: 'primary-key', providerName: 'primary', modelAllowlist: ['primary-model'] }
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

  const status = await request('/api/status');
  assert(status.response.ok, 'status should succeed');
  assert(status.json.data.queueConfigured === true, 'status should report queue binding');
  assert(status.json.data.durableObjectConfigured === true, 'status should report durable object binding');
  assert(status.json.data.relayRateLimitPerMinute === 1, 'status should expose relay rate limit');

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

  const createToken = await request('/api/admin/tokens', {
    method: 'POST',
    cookie: sessionCookie,
    json: {
      name: 'state-plane smoke'
    }
  });
  assert(createToken.response.ok, 'api token creation should succeed');
  const apiToken = createToken.json.data.token;
  const apiTokenId = createToken.json.data.descriptor.id;

  primary.clear();

  const firstChat = await request('/v1/chat/completions', {
    method: 'POST',
    bearerToken: apiToken,
    json: {
      model: 'primary-model',
      messages: [{ role: 'user', content: 'hello state plane' }]
    }
  });
  assert(firstChat.response.ok, 'first chat request should succeed');
  assert(firstChat.json.choices[0].message.content === 'chat-primary', 'first chat request should preserve upstream payload');

  const secondChat = await request('/v1/chat/completions', {
    method: 'POST',
    bearerToken: apiToken,
    json: {
      model: 'primary-model',
      messages: [{ role: 'user', content: 'hello again' }]
    }
  });
  assert(secondChat.response.status === 429, 'second chat request should hit relay rate limit');
  assert(secondChat.json.error.code === 'RATE_LIMITED', 'rate-limited request should return explicit error code');
  assert(primary.hits.filter((hit) => hit.path === '/chat/completions').length === 1, 'rate-limited request should be rejected before reaching upstream');

  const usageResult = await waitForUsageRow(sessionCookie, (row) =>
    row.actorKind === 'api-token'
    && row.actorId === apiTokenId
    && row.upstreamProfileId === 'primary'
    && row.model === 'primary-model'
  );

  assert(usageResult.usage.totals.requestCount === 1, 'usage totals should include queued relay success');
  assert(usageResult.row.requestCount === 1, 'usage row should aggregate one successful relay request');
  assert(usageResult.row.successCount === 1, 'usage row should count success');
  assert(usageResult.row.errorCount === 0, 'usage row should not count rate-limited request as upstream error');
  assert(usageResult.row.lastStatus === 200, 'usage row should preserve last upstream status');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'status endpoint reports queue and durable object bindings',
      'usage queue consumer aggregates relay usage into D1',
      'relay durable object rate limit rejects excess requests before upstream'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
