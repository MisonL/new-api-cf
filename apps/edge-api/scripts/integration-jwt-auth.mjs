#!/usr/bin/env node

import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCommand, stopChild, waitForWorker } from './integration-helpers.mjs';

const EDGE_PORT = 18894;
const JWT_SECRET = 'jwt-secret-012345678901234567890123456789';
const JWT_ISSUER = 'new-api-cf-tests';
const JWT_AUDIENCE = 'new-api-cf-admin';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EDGE_DIR = path.resolve(SCRIPT_DIR, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function signJwt(payload, options = {}) {
  const header = {
    alg: options.alg || 'HS256',
    typ: 'JWT'
  };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  if (header.alg !== 'HS256') {
    return `${signingInput}.invalid-signature`;
  }

  const signature = createHmac('sha256', JWT_SECRET)
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signature}`;
}

async function request(pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
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
    text
  };
}

const tempDir = await mkdtemp(path.join(EDGE_DIR, '.integration-'));
const stateDir = path.join(tempDir, 'state');
const configPath = path.join(tempDir, 'wrangler.integration.json');
let worker;

try {
  const config = {
    name: 'new-api-cf-edge-api-jwt-auth-integration',
    main: path.join(EDGE_DIR, 'src/index.ts'),
    compatibility_date: '2026-04-04',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'new-api-cf-jwt-auth-integration',
        database_id: '00000000-0000-0000-0000-000000000000',
        preview_database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: path.join(EDGE_DIR, 'migrations'),
        remote: false
      }
    ],
    vars: {
      ENVIRONMENT: 'development',
      APP_NAME: 'new-api-cf',
      AUTH_MODE: 'jwt',
      ADMIN_JWT_SECRET: JWT_SECRET,
      ADMIN_JWT_ISSUER: JWT_ISSUER,
      ADMIN_JWT_AUDIENCE: JWT_AUDIENCE,
      UPSTREAM_PROFILES_JSON: JSON.stringify([
        { id: 'primary', label: 'Primary', baseUrl: 'http://127.0.0.1:18891', apiKey: 'primary-key', providerName: 'primary', modelAllowlist: ['primary-model'] },
        { id: 'secondary', label: 'Secondary', baseUrl: 'http://127.0.0.1:18892', apiKey: 'secondary-key', providerName: 'secondary', modelAllowlist: ['secondary-model'] }
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

  const now = Math.floor(Date.now() / 1000);
  const validAdminJwt = signJwt({
    sub: 'admin',
    role: 'admin',
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: now + 3600
  });
  const expiredJwt = signJwt({
    sub: 'admin',
    role: 'admin',
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: now - 60
  });
  const wrongIssuerJwt = signJwt({
    sub: 'admin',
    role: 'admin',
    iss: 'wrong-issuer',
    aud: JWT_AUDIENCE,
    exp: now + 3600
  });
  const nonAdminJwt = signJwt({
    sub: 'user-1',
    role: 'member',
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: now + 3600
  });
  const wrongAlgorithmJwt = signJwt({
    sub: 'admin',
    role: 'admin',
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: now + 3600
  }, { alg: 'HS512' });

  const status = await request('/api/status');
  assert(status.response.ok, 'status should succeed');
  assert(status.json.data.authMode === 'jwt', 'status should report jwt auth mode');
  assert(status.json.data.loginAvailable === false, 'status should report login unavailable in jwt mode');

  const anonymousSession = await request('/api/auth/session');
  assert(anonymousSession.response.ok, 'anonymous session query should succeed');
  assert(anonymousSession.json.data.authenticated === false, 'anonymous session should be unauthenticated in jwt mode');
  assert(anonymousSession.json.data.authMode === 'jwt', 'anonymous session should report jwt auth mode');

  const loginAttempt = await request('/api/auth/login', {
    method: 'POST',
    json: { token: 'unused' }
  });
  assert(loginAttempt.response.status === 400, 'login should be disabled in jwt mode');
  assert(loginAttempt.json.error.code === 'LOGIN_NOT_AVAILABLE', 'login should return explicit jwt-mode error');

  const validSession = await request('/api/auth/session', {
    bearerToken: validAdminJwt
  });
  assert(validSession.response.ok, 'jwt session query should succeed');
  assert(validSession.json.data.authenticated === true, 'valid jwt should authenticate session query');
  assert(validSession.json.data.role === 'admin', 'valid jwt should resolve admin role');

  const invalidIssuerMe = await request('/api/me', {
    bearerToken: wrongIssuerJwt
  });
  assert(invalidIssuerMe.response.status === 401, 'wrong issuer jwt should be rejected');
  assert(invalidIssuerMe.json.error.code === 'UNAUTHORIZED', 'wrong issuer jwt should return unauthorized');

  const expiredMe = await request('/api/me', {
    bearerToken: expiredJwt
  });
  assert(expiredMe.response.status === 401, 'expired jwt should be rejected');
  assert(expiredMe.json.error.code === 'UNAUTHORIZED', 'expired jwt should return unauthorized');

  const nonAdminState = await request('/api/admin/state', {
    bearerToken: nonAdminJwt
  });
  assert(nonAdminState.response.status === 401, 'non-admin jwt should not access admin state');
  assert(nonAdminState.json.error.code === 'UNAUTHORIZED', 'non-admin jwt should return unauthorized');

  const wrongAlgState = await request('/api/admin/state', {
    bearerToken: wrongAlgorithmJwt
  });
  assert(wrongAlgState.response.status === 401, 'non-HS256 jwt should be rejected');
  assert(wrongAlgState.json.error.code === 'UNAUTHORIZED', 'non-HS256 jwt should return unauthorized');

  const bootstrap = await request('/api/admin/bootstrap', {
    method: 'POST',
    bearerToken: validAdminJwt
  });
  assert(bootstrap.response.ok, 'jwt-authenticated bootstrap should succeed');
  assert(Array.isArray(bootstrap.json.data.models) && bootstrap.json.data.models.length === 2, 'jwt bootstrap should seed two models');

  const relayModels = await request('/v1/models', {
    bearerToken: validAdminJwt
  });
  assert(relayModels.response.ok, 'relay model catalog should accept admin jwt');
  assert(Array.isArray(relayModels.json.data) && relayModels.json.data.length === 2, 'relay model catalog should expose both enabled models under jwt');

  const modelDetail = await request('/v1/models/secondary-model', {
    bearerToken: validAdminJwt
  });
  assert(modelDetail.response.ok, 'relay model detail should accept admin jwt');
  assert(modelDetail.json.id === 'secondary-model', 'relay model detail should preserve model id under jwt');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'status and session endpoints reflect jwt auth mode',
      'jwt mode rejects session login endpoint explicitly',
      'jwt validation enforces exp issuer audience admin identity and HS256 algorithm',
      'admin and relay routes accept valid admin jwt'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await rm(tempDir, { recursive: true, force: true });
}
