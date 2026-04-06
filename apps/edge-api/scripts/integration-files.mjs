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
    name: 'new-api-cf-edge-api-files-integration',
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

  const upload = new FormData();
  upload.set('purpose', 'assistants');
  upload.set('file', new Blob(['hello file'], { type: 'text/plain' }), 'hello.txt');
  const createFile = await request('/v1/files', {
    method: 'POST',
    body: upload
  });
  assert(createFile.response.ok, 'file upload should succeed');
  assert(createFile.json.id === 'file_primary', 'file should be created on default upstream');
  assert(countHits(primary, (hit) => hit.path === '/files' && hit.contentType.includes('multipart/form-data') && hit.rawBody.includes('hello file')) === 1, 'file upload should preserve multipart payload');
  assert(countHits(secondary, (hit) => hit.path === '/files') === 0, 'file upload should not hit secondary');

  primary.clear();
  secondary.clear();

  const listFiles = await request('/v1/files?purpose=assistants&limit=1');
  assert(listFiles.response.ok, 'file list should succeed');
  assert(Array.isArray(listFiles.json.data), 'file list should return list data');
  assert(listFiles.json.data[0]?.filename === 'file-primary.txt', 'file list should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/files' && hit.method === 'GET' && hit.search === '?purpose=assistants&limit=1') === 1, 'file list should preserve query string on primary');

  primary.clear();
  secondary.clear();

  const fileInfo = await request('/v1/files/file_primary');
  assert(fileInfo.response.ok, 'file detail should succeed');
  assert(fileInfo.json.metadata.source === 'primary', 'file detail should preserve upstream metadata');
  assert(fileInfo.json.bytes === 11, 'file detail should preserve upstream scalar fields');
  assert(countHits(primary, (hit) => hit.path === '/files/file_primary') === 1, 'file detail should hit primary');

  primary.clear();
  secondary.clear();

  const fileContent = await request('/v1/files/file_primary/content');
  assert(fileContent.response.ok, 'file content should succeed');
  assert(fileContent.text === 'file-content-primary', 'file content should be proxied without JSON wrapping');
  assert(countHits(primary, (hit) => hit.path === '/files/file_primary/content') === 1, 'file content should hit primary');

  primary.clear();
  secondary.clear();

  const deleteFile = await request('/v1/files/file_primary', { method: 'DELETE' });
  assert(deleteFile.response.ok, 'file delete should succeed');
  assert(deleteFile.json.deleted === true, 'file delete should return deleted flag');
  assert(countHits(primary, (hit) => hit.path === '/files/file_primary' && hit.method === 'DELETE') === 1, 'file delete should hit primary');
  assert(countHits(secondary, (hit) => hit.path.startsWith('/files')) === 0, 'file routes should remain on default upstream');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'file utility routes use default upstream profile',
      'file list and detail preserve query string and upstream payloads',
      'file upload preserves multipart payload',
      'file content passthrough keeps raw upstream response'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
