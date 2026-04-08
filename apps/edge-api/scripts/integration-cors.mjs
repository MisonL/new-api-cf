#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCommand, stopChild, waitForWorker } from './integration-helpers.mjs';

const EDGE_PORT = 18894;
const ADMIN_TOKEN = 'admin-dev-token';
const SESSION_SECRET = 'session-secret-012345678901234567';
const ALLOWED_ORIGIN = 'https://admin.example.com';
const DISALLOWED_ORIGIN = 'https://evil.example.com';
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
  if (init.origin) {
    headers.set('origin', init.origin);
  }
  if (init.accessControlRequestMethod) {
    headers.set('access-control-request-method', init.accessControlRequestMethod);
  }
  if (init.accessControlRequestHeaders) {
    headers.set('access-control-request-headers', init.accessControlRequestHeaders);
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
    setCookie: response.headers.get('set-cookie')
  };
}

function readCookie(setCookie) {
  return setCookie ? setCookie.split(';', 1)[0] : '';
}

const tempDir = await mkdtemp(path.join(EDGE_DIR, '.integration-'));
const stateDir = path.join(tempDir, 'state');
const configPath = path.join(tempDir, 'wrangler.integration.json');
let worker;

try {
  const config = {
    name: 'new-api-cf-edge-api-cors-integration',
    main: path.join(EDGE_DIR, 'src/index.ts'),
    compatibility_date: '2026-04-04',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'new-api-cf-cors-integration',
        database_id: '00000000-0000-0000-0000-000000000000',
        preview_database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: path.join(EDGE_DIR, 'migrations'),
        remote: false
      }
    ],
    vars: {
      ENVIRONMENT: 'development',
      APP_NAME: 'new-api-cf',
      AUTH_MODE: 'session',
      ADMIN_BEARER_TOKEN: ADMIN_TOKEN,
      SESSION_SECRET,
      CORS_ORIGIN: `${ALLOWED_ORIGIN},http://127.0.0.1:4173`,
      UPSTREAM_PROFILES_JSON: JSON.stringify([
        { id: 'primary', label: 'Primary', baseUrl: 'http://127.0.0.1:18891', apiKey: 'primary-key', providerName: 'primary', modelAllowlist: ['primary-model'] }
      ]),
      UPSTREAM_DEFAULT_PROFILE_ID: 'primary'
    }
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await runCommand('bunx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir, '-c', configPath], { cwd: EDGE_DIR });
  worker = spawn('bunx', ['wrangler', 'dev', '--local', '--port', String(EDGE_PORT), '--persist-to', stateDir, '-c', configPath], {
    cwd: EDGE_DIR,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  worker.stdout.on('data', (chunk) => process.stdout.write(String(chunk)));
  worker.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));

  await waitForWorker(`http://127.0.0.1:${EDGE_PORT}/api/status`);

  const preflightAllowed = await request('/api/admin/models/primary-model', {
    method: 'OPTIONS',
    origin: ALLOWED_ORIGIN,
    accessControlRequestMethod: 'PATCH',
    accessControlRequestHeaders: 'content-type, authorization'
  });
  assert(preflightAllowed.response.status === 204, 'allowed origin preflight should return 204');
  assert(preflightAllowed.response.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'allowed origin preflight should echo allowed origin');
  assert(preflightAllowed.response.headers.get('access-control-allow-credentials') === 'true', 'allowed origin preflight should allow credentials');
  assert((preflightAllowed.response.headers.get('access-control-allow-methods') || '').includes('PATCH'), 'preflight should include PATCH');
  assert((preflightAllowed.response.headers.get('access-control-allow-methods') || '').includes('PUT'), 'preflight should include PUT');
  assert((preflightAllowed.response.headers.get('access-control-allow-methods') || '').includes('DELETE'), 'preflight should include DELETE');
  assert((preflightAllowed.response.headers.get('access-control-allow-headers') || '').includes('Authorization'), 'preflight should include Authorization header');

  const preflightDisallowed = await request('/api/admin/models/primary-model', {
    method: 'OPTIONS',
    origin: DISALLOWED_ORIGIN,
    accessControlRequestMethod: 'PATCH'
  });
  assert(preflightDisallowed.response.status === 204, 'disallowed origin preflight should still short-circuit');
  assert(!preflightDisallowed.response.headers.get('access-control-allow-origin'), 'disallowed origin preflight should not emit allow-origin');

  const login = await request('/api/auth/login', {
    method: 'POST',
    origin: ALLOWED_ORIGIN,
    json: { token: ADMIN_TOKEN }
  });
  assert(login.response.ok, 'login should succeed');
  assert(login.response.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'allowed origin login should emit allow-origin');
  const sessionCookie = readCookie(login.setCookie);
  assert(sessionCookie.length > 0, 'login should issue session cookie');

  const bootstrap = await request('/api/admin/bootstrap', {
    method: 'POST',
    origin: ALLOWED_ORIGIN,
    cookie: sessionCookie
  });
  assert(bootstrap.response.ok, 'bootstrap should succeed');
  assert(bootstrap.response.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'bootstrap should preserve cors headers on actual response');

  const updateModel = await request('/api/admin/models/primary-model', {
    method: 'PATCH',
    origin: ALLOWED_ORIGIN,
    cookie: sessionCookie,
    json: {
      label: 'Primary Model',
      enabled: true,
      upstreamProfileId: 'primary'
    }
  });
  assert(updateModel.response.ok, 'patch request should succeed under allowed origin');
  assert(updateModel.response.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'patch response should preserve allow-origin');

  const disallowedStatus = await request('/api/status', {
    origin: DISALLOWED_ORIGIN
  });
  assert(disallowedStatus.response.ok, 'status should succeed for disallowed origin request');
  assert(!disallowedStatus.response.headers.get('access-control-allow-origin'), 'disallowed origin actual response should not emit allow-origin');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'allowed origin preflight exposes patch put delete methods',
      'disallowed origin requests do not receive cors allow-origin headers',
      'actual admin responses preserve cors headers for allowed origins'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await rm(tempDir, { recursive: true, force: true });
}
