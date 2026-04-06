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
    name: 'new-api-cf-edge-api-realtime-integration',
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

  const model = await request('/v1/models/secondary-model');
  assert(model.response.ok, 'model detail should be returned from local catalog');
  assert(model.json.id === 'secondary-model', 'model detail should match requested model');

  const clientSecret = await request('/v1/realtime/client_secrets', {
    method: 'POST',
    body: JSON.stringify({
      session: {
        model: 'secondary-model',
        type: 'realtime'
      }
    })
  });
  assert(clientSecret.response.ok, 'realtime client secret creation should succeed');
  assert(clientSecret.json.id === 'secret_secondary', 'realtime client secret should use selected upstream');
  assert(countHits(primary, (hit) => hit.path === '/realtime/client_secrets') === 0, 'primary must not receive secondary client secret request');
  assert(countHits(secondary, (hit) => hit.path === '/realtime/client_secrets' && hit.body?.session?.model === 'secondary-model') === 1, 'secondary should receive client secret request');

  primary.clear();
  secondary.clear();

  const session = await request('/v1/realtime/sessions', {
    method: 'POST',
    body: JSON.stringify({ model: 'secondary-model', type: 'realtime' })
  });
  assert(session.response.ok, 'realtime session creation should succeed');
  assert(session.json.id === 'sess_secondary', 'realtime session should use selected upstream');
  assert(countHits(primary, (hit) => hit.path === '/realtime/sessions') === 0, 'primary must not receive secondary session request');
  assert(countHits(secondary, (hit) => hit.path === '/realtime/sessions') === 1, 'secondary should receive session request');

  primary.clear();
  secondary.clear();

  const transcriptionSession = await request('/v1/realtime/transcription_sessions', {
    method: 'POST',
    body: JSON.stringify({
      input_audio_transcription: {
        model: 'secondary-model'
      },
      turn_detection: {
        type: 'server_vad'
      }
    })
  });
  assert(transcriptionSession.response.ok, 'realtime transcription session should succeed');
  assert(transcriptionSession.json.id === 'tsess_secondary', 'realtime transcription session should use selected upstream');
  assert(countHits(primary, (hit) => hit.path === '/realtime/transcription_sessions') === 0, 'primary must not receive secondary transcription session request');
  assert(countHits(secondary, (hit) => hit.path === '/realtime/transcription_sessions' && hit.body?.input_audio_transcription?.model === 'secondary-model') === 1, 'secondary should receive transcription session request');

  primary.clear();
  secondary.clear();

  const callForm = new FormData();
  callForm.set('sdp', 'offer-secondary');
  callForm.set('session', JSON.stringify({ model: 'secondary-model', type: 'realtime' }));
  const call = await request('/v1/realtime/calls', {
    method: 'POST',
    body: callForm
  });
  assert(call.response.status === 201, 'realtime call creation should return 201');
  assert(call.text === 'answer-secondary', 'call SDP response should be proxied');
  assert(call.response.headers.get('location') === '/v1/realtime/calls/call_secondary', 'call location header should be preserved');
  assert(countHits(secondary, (hit) => hit.path === '/realtime/calls') === 1, 'secondary should receive call create');

  primary.clear();
  secondary.clear();

  const referUnknown = await request('/v1/realtime/calls/call_missing/refer', {
    method: 'POST',
    body: JSON.stringify({ target_uri: 'tel:+14155550123' })
  });
  assert(referUnknown.response.status === 503, 'unknown call should fail explicitly');
  assert(referUnknown.json.error.code === 'REALTIME_CALL_PROFILE_UNKNOWN', 'unknown call should not silently fallback');

  const refer = await request('/v1/realtime/calls/call_secondary/refer', {
    method: 'POST',
    body: JSON.stringify({ target_uri: 'tel:+14155550123' })
  });
  assert(refer.response.ok, 'known call refer should succeed');
  assert(countHits(primary, (hit) => hit.path === '/realtime/calls/call_secondary/refer') === 0, 'refer should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/realtime/calls/call_secondary/refer') === 1, 'refer should hit secondary');

  primary.clear();
  secondary.clear();

  const hangup = await request('/v1/realtime/calls/call_secondary/hangup', { method: 'POST' });
  assert(hangup.response.ok, 'known call hangup should succeed');
  assert(countHits(secondary, (hit) => hit.path === '/realtime/calls/call_secondary/hangup') === 1, 'hangup should hit stored upstream');

  primary.clear();
  secondary.clear();

  const hangupUnknown = await request('/v1/realtime/calls/call_secondary/hangup', { method: 'POST' });
  assert(hangupUnknown.response.status === 503, 'hung up call should remove registry and fail on second hangup');

  const accept = await request('/v1/realtime/calls/call_primary/accept', {
    method: 'POST',
    body: JSON.stringify({ model: 'primary-model', type: 'realtime' })
  });
  assert(accept.response.ok, 'call accept should succeed');
  assert(countHits(primary, (hit) => hit.path === '/realtime/calls/call_primary/accept') === 1, 'accept should route by model to primary');

  primary.clear();
  secondary.clear();

  const reject = await request('/v1/realtime/calls/call_primary/reject', {
    method: 'POST',
    body: JSON.stringify({ status_code: 486 })
  });
  assert(reject.response.ok, 'call reject should succeed after accept registry write');
  assert(countHits(primary, (hit) => hit.path === '/realtime/calls/call_primary/reject') === 1, 'reject should route via stored profile');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'model detail endpoint',
      'realtime client secret model routing',
      'realtime session model routing',
      'realtime transcription session model routing',
      'realtime call location passthrough',
      'realtime call profile registry',
      'explicit failure for unknown realtime call profile'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
