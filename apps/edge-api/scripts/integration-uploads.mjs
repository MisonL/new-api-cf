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
    name: 'new-api-cf-edge-api-uploads-integration',
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

  const createUpload = await request('/v1/uploads', {
    method: 'POST',
    body: JSON.stringify({
      bytes: 11,
      filename: 'hello.txt',
      mime_type: 'text/plain',
      purpose: 'assistants',
      expires_after: {
        anchor: 'created_at',
        seconds: 300
      }
    })
  });
  assert(createUpload.response.ok, 'upload creation should succeed');
  assert(createUpload.json.id === 'upload_primary', 'upload should be created on default upstream');
  assert(countHits(primary, (hit) => hit.path === '/uploads' && hit.body?.expires_after?.seconds === 300 && hit.body?.purpose === 'assistants') === 1, 'upload creation should preserve JSON payload and hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/uploads') === 0, 'upload creation should not hit secondary');

  primary.clear();
  secondary.clear();

  const uploadInfo = await request('/v1/uploads/upload_primary');
  assert(uploadInfo.response.ok, 'upload detail should succeed');
  assert(countHits(primary, (hit) => hit.path === '/uploads/upload_primary') === 1, 'upload detail should hit primary');

  primary.clear();
  secondary.clear();

  const listParts = await request('/v1/uploads/upload_primary/parts?limit=2');
  assert(listParts.response.ok, 'upload part list should succeed');
  assert(Array.isArray(listParts.json.data), 'upload part list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/uploads/upload_primary/parts' && hit.method === 'GET' && hit.search === '?limit=2') === 1, 'upload part list should preserve query string on primary');

  primary.clear();
  secondary.clear();

  const formData = new FormData();
  formData.set('data', new Blob(['hello world'], { type: 'text/plain' }), 'hello.txt');
  const uploadPart = await request('/v1/uploads/upload_primary/parts', {
    method: 'POST',
    body: formData
  });
  assert(uploadPart.response.ok, 'upload part should succeed');
  assert(uploadPart.json.id === 'part_primary', 'upload part should be created on default upstream');
  assert(countHits(primary, (hit) => hit.path === '/uploads/upload_primary/parts' && hit.contentType.includes('multipart/form-data') && hit.rawBody.includes('hello world')) === 1, 'upload part should preserve multipart payload');

  primary.clear();
  secondary.clear();

  const partInfo = await request('/v1/uploads/upload_primary/parts/part_primary');
  assert(partInfo.response.ok, 'upload part detail should succeed');
  assert(countHits(primary, (hit) => hit.path === '/uploads/upload_primary/parts/part_primary') === 1, 'upload part detail should hit primary');

  primary.clear();
  secondary.clear();

  const completeUpload = await request('/v1/uploads/upload_primary/complete', {
    method: 'POST',
    body: JSON.stringify({
      part_ids: ['part_primary'],
      md5: '8ddd8be4b179a529afa5f2ffae4b9858'
    })
  });
  assert(completeUpload.response.ok, 'upload complete should succeed');
  assert(completeUpload.json.status === 'completed', 'upload complete should return completed status');
  assert(countHits(primary, (hit) => hit.path === '/uploads/upload_primary/complete' && hit.body?.md5 === '8ddd8be4b179a529afa5f2ffae4b9858' && Array.isArray(hit.body?.part_ids)) === 1, 'upload complete should preserve JSON payload and hit primary');

  primary.clear();
  secondary.clear();

  const cancelUpload = await request('/v1/uploads/upload_cancel_primary/cancel', { method: 'POST' });
  assert(cancelUpload.response.ok, 'upload cancel should succeed');
  assert(cancelUpload.json.status === 'cancelled', 'upload cancel should return cancelled status');
  assert(countHits(primary, (hit) => hit.path === '/uploads/upload_cancel_primary/cancel') === 1, 'upload cancel should hit primary');
  assert(countHits(secondary, (hit) => hit.path.startsWith('/uploads')) === 0, 'upload routes should never hit secondary in default profile mode');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'upload utility routes use default upstream profile',
      'upload create and complete preserve JSON payloads',
      'upload part routes preserve multipart payload and query string',
      'upload complete and cancel stay on default upstream'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
