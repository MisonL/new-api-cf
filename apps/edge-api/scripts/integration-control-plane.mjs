#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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
  const json = text ? JSON.parse(text) : null;
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
    name: 'new-api-cf-edge-api-control-plane-integration',
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
      AUTH_MODE: 'session',
      ADMIN_BEARER_TOKEN: ADMIN_TOKEN,
      SESSION_SECRET,
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
    stdio: ['ignore', 'pipe', 'pipe']
  });
  worker.stdout.on('data', (chunk) => process.stdout.write(String(chunk)));
  worker.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));

  await waitForWorker(`http://127.0.0.1:${EDGE_PORT}/api/status`);

  const statusBeforeBootstrap = await request('/api/status');
  assert(statusBeforeBootstrap.response.ok, 'status before bootstrap should succeed');
  assert(statusBeforeBootstrap.json.data.authMode === 'session', 'status should report session auth mode');
  assert(statusBeforeBootstrap.json.data.loginAvailable === true, 'status should report login availability in session mode');
  assert(statusBeforeBootstrap.json.data.modelCount === 0, 'status before bootstrap should report empty model catalog');

  const anonymousSession = await request('/api/auth/session');
  assert(anonymousSession.response.ok, 'anonymous session query should succeed');
  assert(anonymousSession.json.data.authenticated === false, 'anonymous session should be unauthenticated');

  const invalidLogin = await request('/api/auth/login', {
    method: 'POST',
    json: { token: 'wrong-token' }
  });
  assert(invalidLogin.response.status === 401, 'invalid login token should be rejected');
  assert(invalidLogin.json.error.code === 'INVALID_LOGIN_TOKEN', 'invalid login should return explicit error code');

  const login = await request('/api/auth/login', {
    method: 'POST',
    json: { token: ADMIN_TOKEN }
  });
  assert(login.response.ok, 'login should succeed');
  assert(login.json.data.authenticated === true, 'login should return authenticated session');
  const sessionCookie = readCookie(login.setCookie);
  assert(sessionCookie.length > 0, 'login should return a session cookie');

  const sessionAfterLogin = await request('/api/auth/session', {
    cookie: sessionCookie
  });
  assert(sessionAfterLogin.response.ok, 'session query after login should succeed');
  assert(sessionAfterLogin.json.data.authenticated === true, 'session query after login should be authenticated');

  const me = await request('/api/me', {
    cookie: sessionCookie
  });
  assert(me.response.ok, 'me endpoint should succeed with session cookie');
  assert(me.json.data.userId === 'admin', 'me endpoint should resolve admin session');

  const stateBeforeBootstrap = await request('/api/admin/state', {
    cookie: sessionCookie
  });
  assert(stateBeforeBootstrap.response.ok, 'admin state before bootstrap should succeed');
  assert(stateBeforeBootstrap.json.data.stateStore === 'd1', 'admin state should use D1 when configured');
  assert(Array.isArray(stateBeforeBootstrap.json.data.models) && stateBeforeBootstrap.json.data.models.length === 0, 'admin state before bootstrap should have no models');

  const bootstrap = await request('/api/admin/bootstrap', {
    method: 'POST',
    cookie: sessionCookie
  });
  assert(bootstrap.response.ok, 'control plane bootstrap should succeed');
  assert(Array.isArray(bootstrap.json.data.models) && bootstrap.json.data.models.length === 2, 'bootstrap should seed both models from upstream profiles');

  const publicModels = await request('/api/models');
  assert(publicModels.response.ok, 'public model catalog should succeed');
  assert(Array.isArray(publicModels.json.data.data) && publicModels.json.data.data.length === 2, 'public model catalog should expose both enabled models');

  const relayModels = await request('/v1/models', {
    cookie: sessionCookie
  });
  assert(relayModels.response.ok, 'relay model catalog should succeed with admin session');
  assert(Array.isArray(relayModels.json.data) && relayModels.json.data.length === 2, 'relay model catalog should expose both enabled models');

  const modelDetail = await request('/v1/models/secondary-model', {
    cookie: sessionCookie
  });
  assert(modelDetail.response.ok, 'single model detail should succeed');
  assert(modelDetail.json.id === 'secondary-model', 'single model detail should preserve model id');

  const updateModel = await request('/api/admin/models/secondary-model', {
    method: 'PATCH',
    cookie: sessionCookie,
    json: {
      label: 'Secondary Model',
      enabled: false,
      upstreamProfileId: 'secondary'
    }
  });
  assert(updateModel.response.ok, 'model update should succeed');
  assert(updateModel.json.data.saved === true, 'model update should confirm save');

  const modelsAfterDisable = await request('/api/models');
  assert(modelsAfterDisable.response.ok, 'public model catalog after disable should succeed');
  assert(modelsAfterDisable.json.data.data.length === 1, 'disabled model should disappear from enabled model catalog');
  assert(modelsAfterDisable.json.data.data[0].id === 'primary-model', 'remaining enabled model should be primary-model');

  const statusAfterDisable = await request('/api/status');
  assert(statusAfterDisable.response.ok, 'status after disable should succeed');
  assert(statusAfterDisable.json.data.modelCount === 1, 'status after disable should reflect enabled model count');

  const createToken = await request('/api/admin/tokens', {
    method: 'POST',
    cookie: sessionCookie,
    json: {
      name: 'control-plane smoke'
    }
  });
  assert(createToken.response.ok, 'api token creation should succeed');
  assert(createToken.json.data.token && createToken.json.data.descriptor?.id, 'api token creation should return token and descriptor');
  const apiToken = createToken.json.data.token;
  const apiTokenId = createToken.json.data.descriptor.id;

  const listTokens = await request('/api/admin/tokens', {
    cookie: sessionCookie
  });
  assert(listTokens.response.ok, 'token list should succeed');
  assert(Array.isArray(listTokens.json.data.data) && listTokens.json.data.data.length === 1, 'token list should include created token');

  const relayModelsViaToken = await request('/v1/models', {
    bearerToken: apiToken
  });
  assert(relayModelsViaToken.response.ok, 'relay model catalog should succeed with api token');
  assert(relayModelsViaToken.json.data.length === 1, 'api token should see updated enabled model catalog');

  const missingDisabledModel = await request('/v1/models/secondary-model', {
    bearerToken: apiToken
  });
  assert(missingDisabledModel.response.status === 404, 'disabled model should not be exposed through relay model detail');
  assert(missingDisabledModel.json.error.code === 'MODEL_NOT_FOUND', 'disabled model detail should return explicit error code');

  const invalidUsageWindow = await request('/api/admin/usage?days=31', {
    cookie: sessionCookie
  });
  assert(invalidUsageWindow.response.status === 400, 'invalid usage window should be rejected');
  assert(invalidUsageWindow.json.error.code === 'INVALID_USAGE_WINDOW', 'invalid usage window should return explicit error code');

  const validUsageWindow = await request('/api/admin/usage?days=7', {
    cookie: sessionCookie
  });
  assert(validUsageWindow.response.ok, 'valid usage window should succeed');

  const disableToken = await request(`/api/admin/tokens/${apiTokenId}`, {
    method: 'PATCH',
    cookie: sessionCookie,
    json: {
      name: 'control-plane smoke',
      enabled: false
    }
  });
  assert(disableToken.response.ok, 'token disable should succeed');

  const rejectedDisabledToken = await request('/v1/models', {
    bearerToken: apiToken
  });
  assert(rejectedDisabledToken.response.status === 401, 'disabled api token should be rejected');
  assert(rejectedDisabledToken.json.error.code === 'INVALID_API_TOKEN', 'disabled api token should return explicit error code');

  const deleteToken = await request(`/api/admin/tokens/${apiTokenId}`, {
    method: 'DELETE',
    cookie: sessionCookie
  });
  assert(deleteToken.response.ok, 'token delete should succeed');
  assert(deleteToken.json.data.deleted === true, 'token delete should return deleted flag');

  const logout = await request('/api/auth/logout', {
    method: 'POST',
    cookie: sessionCookie
  });
  assert(logout.response.ok, 'logout should succeed');
  assert(logout.json.data.authenticated === false, 'logout should return unauthenticated state');
  const clearedCookie = readCookie(logout.setCookie);
  assert(clearedCookie.length > 0, 'logout should emit a clearing cookie');

  const meAfterLogout = await request('/api/me', {
    cookie: clearedCookie
  });
  assert(meAfterLogout.response.status === 401, 'cleared session cookie should no longer authorize admin routes');
  assert(meAfterLogout.json.error.code === 'UNAUTHORIZED', 'cleared session cookie should return explicit unauthorized error');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'status and session endpoints reflect session-mode control plane state',
      'login and logout manage admin session cookies explicitly',
      'bootstrap, model updates, and usage validation behave correctly through admin routes',
      'api token lifecycle gates relay model access after model and token changes'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await rm(tempDir, { recursive: true, force: true });
}
