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
    name: 'new-api-cf-edge-api-fine-tuning-integration',
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

  const listJobs = await request('/v1/fine_tuning/jobs?limit=1');
  assert(listJobs.response.ok, 'job list should succeed');
  assert(Array.isArray(listJobs.json.data), 'job list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/jobs' && hit.method === 'GET' && hit.search === '?limit=1') === 1, 'job list should hit default upstream and preserve query string');
  assert(countHits(secondary, (hit) => hit.path.startsWith('/fine_tuning/jobs')) === 0, 'job list should not hit secondary');

  primary.clear();
  secondary.clear();

  const createJob = await request('/v1/fine_tuning/jobs', {
    method: 'POST',
    body: JSON.stringify({
      model: 'primary-model',
      training_file: 'file_train_123',
      validation_file: 'file_valid_123',
      suffix: 'smoke'
    })
  });
  assert(createJob.response.ok, 'job create should succeed');
  assert(createJob.json.id === 'ftjob_created', 'job create should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/jobs' && hit.method === 'POST' && hit.body?.training_file === 'file_train_123') === 1, 'job create should hit default upstream with request payload');

  primary.clear();
  secondary.clear();

  const readJob = await request('/v1/fine_tuning/jobs/ftjob_123');
  assert(readJob.response.ok, 'job detail should succeed');
  assert(readJob.json.id === 'ftjob_123', 'job detail should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/jobs/ftjob_123' && hit.method === 'GET') === 1, 'job detail should hit default upstream');

  primary.clear();
  secondary.clear();

  const cancelJob = await request('/v1/fine_tuning/jobs/ftjob_123/cancel', { method: 'POST' });
  assert(cancelJob.response.ok, 'cancel endpoint should succeed');
  assert(cancelJob.json.status === 'cancelled', 'cancel endpoint should return cancelled status');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/jobs/ftjob_123/cancel') === 1, 'cancel should hit default upstream');

  primary.clear();
  secondary.clear();

  const pause = await request('/v1/fine_tuning/jobs/ftjob_123/pause', { method: 'POST' });
  assert(pause.response.ok, 'pause endpoint should succeed');
  assert(pause.json.status === 'paused', 'pause endpoint should return paused status');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/jobs/ftjob_123/pause') === 1, 'pause should hit default upstream');
  assert(countHits(secondary, (hit) => hit.path === '/fine_tuning/jobs/ftjob_123/pause') === 0, 'pause should not hit secondary');

  primary.clear();
  secondary.clear();

  const resume = await request('/v1/fine_tuning/jobs/ftjob_123/resume', { method: 'POST' });
  assert(resume.response.ok, 'resume endpoint should succeed');
  assert(resume.json.status === 'running', 'resume endpoint should return running status');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/jobs/ftjob_123/resume') === 1, 'resume should hit default upstream');
  assert(countHits(secondary, (hit) => hit.path === '/fine_tuning/jobs/ftjob_123/resume') === 0, 'resume should not hit secondary');

  primary.clear();
  secondary.clear();

  const listEvents = await request('/v1/fine_tuning/jobs/ftjob_123/events?limit=2');
  assert(listEvents.response.ok, 'events endpoint should succeed');
  assert(Array.isArray(listEvents.json.data), 'events endpoint should return list data');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/jobs/ftjob_123/events' && hit.method === 'GET' && hit.search === '?limit=2') === 1, 'events should hit default upstream and preserve query string');

  primary.clear();
  secondary.clear();

  const listCheckpoints = await request('/v1/fine_tuning/jobs/ftjob_123/checkpoints?limit=2');
  assert(listCheckpoints.response.ok, 'checkpoints endpoint should succeed');
  assert(Array.isArray(listCheckpoints.json.data), 'checkpoints endpoint should return list data');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/jobs/ftjob_123/checkpoints' && hit.method === 'GET' && hit.search === '?limit=2') === 1, 'checkpoints should hit default upstream and preserve query string');

  primary.clear();
  secondary.clear();

  const listPermissions = await request('/v1/fine_tuning/checkpoints/ftckpt_123/permissions?limit=1');
  assert(listPermissions.response.ok, 'checkpoint permissions list should succeed');
  assert(Array.isArray(listPermissions.json.data), 'checkpoint permissions list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/checkpoints/ftckpt_123/permissions' && hit.method === 'GET' && hit.search === '?limit=1') === 1, 'checkpoint permissions list should hit default upstream and preserve query string');

  primary.clear();
  secondary.clear();

  const createPermission = await request('/v1/fine_tuning/checkpoints/ftckpt_123/permissions', {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert(createPermission.response.ok, 'checkpoint permission create should succeed');
  assert(createPermission.json.id === 'perm_created', 'checkpoint permission create should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/checkpoints/ftckpt_123/permissions' && hit.method === 'POST') === 1, 'checkpoint permission create should hit default upstream');

  primary.clear();
  secondary.clear();

  const deletePermission = await request('/v1/fine_tuning/checkpoints/ftckpt_123/permissions/perm_123', { method: 'DELETE' });
  assert(deletePermission.response.ok, 'checkpoint permission delete should succeed');
  assert(deletePermission.json.deleted === true, 'checkpoint permission delete should return deleted flag');
  assert(countHits(primary, (hit) => hit.path === '/fine_tuning/checkpoints/ftckpt_123/permissions/perm_123' && hit.method === 'DELETE') === 1, 'checkpoint permission delete should hit default upstream');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'fine-tuning job utility routes preserve query strings and payloads',
      'fine-tuning pause endpoint',
      'fine-tuning resume endpoint',
      'fine-tuning checkpoint permission routes stay on default upstream'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
