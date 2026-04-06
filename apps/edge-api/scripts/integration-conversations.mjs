#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCommand, stopChild, waitForWorker } from './integration-helpers.mjs';
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
    name: 'new-api-cf-edge-api-conversations-integration',
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

  const createConversation = await request('/v1/conversations', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ role: 'system', content: 'seed' }],
      metadata: {
        source: 'integration'
      }
    })
  });
  assert(createConversation.response.ok, 'conversation creation should succeed');
  assert(createConversation.json.id === 'conv_primary', 'conversation should be created on default upstream');
  assert(Array.isArray(createConversation.json.items), 'conversation creation should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/conversations' && hit.method === 'POST' && hit.body?.items?.[0]?.role === 'system' && hit.body?.metadata?.source === 'integration') === 1, 'conversation creation should preserve JSON payload on primary');
  assert(countHits(secondary, (hit) => hit.path === '/conversations') === 0, 'conversation creation should not hit secondary');

  primary.clear();
  secondary.clear();

  const readConversation = await request('/v1/conversations/conv_primary');
  assert(readConversation.response.ok, 'conversation detail should succeed');
  assert(readConversation.json.metadata.source === 'primary', 'conversation detail should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/conversations/conv_primary') === 1, 'conversation detail should hit primary');

  primary.clear();
  secondary.clear();

  const updateConversation = await request('/v1/conversations/conv_primary', {
    method: 'POST',
    body: JSON.stringify({
      metadata: {
        updated: 'true'
      }
    })
  });
  assert(updateConversation.response.ok, 'conversation update should succeed');
  assert(updateConversation.json.metadata.updated === 'true', 'conversation update should preserve JSON payload');
  assert(countHits(primary, (hit) => hit.path === '/conversations/conv_primary' && hit.method === 'POST' && hit.body?.metadata?.updated === 'true') === 1, 'conversation update should preserve JSON payload on primary');

  primary.clear();
  secondary.clear();

  const listItems = await request('/v1/conversations/conv_primary/items?limit=1');
  assert(listItems.response.ok, 'conversation item list should succeed');
  assert(Array.isArray(listItems.json.data), 'conversation item list should return list data');
  assert(countHits(primary, (hit) => hit.path === '/conversations/conv_primary/items' && hit.method === 'GET' && hit.search === '?limit=1') === 1, 'conversation item list should preserve query string on primary');

  primary.clear();
  secondary.clear();

  const createItems = await request('/v1/conversations/conv_primary/items', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ role: 'user', content: 'hello' }]
    })
  });
  assert(createItems.response.ok, 'conversation item create should succeed');
  assert(Array.isArray(createItems.json.data), 'conversation item create should return list data');
  assert(createItems.json.data[0]?.role === 'user', 'conversation item create should preserve upstream payload');
  assert(countHits(primary, (hit) => hit.path === '/conversations/conv_primary/items' && hit.method === 'POST' && hit.body?.items?.[0]?.content === 'hello') === 1, 'conversation item create should preserve JSON payload on primary');

  primary.clear();
  secondary.clear();

  const readItem = await request('/v1/conversations/conv_primary/items/item_primary?include=content');
  assert(readItem.response.ok, 'conversation item detail should succeed');
  assert(readItem.json.id === 'item_primary', 'conversation item detail should preserve upstream payload');
  assert(readItem.json.role === 'user', 'conversation item detail should preserve upstream metadata');
  assert(countHits(primary, (hit) => hit.path === '/conversations/conv_primary/items/item_primary' && hit.method === 'GET' && hit.search === '?include=content') === 1, 'conversation item detail should preserve query string on primary');

  primary.clear();
  secondary.clear();

  const deleteItem = await request('/v1/conversations/conv_primary/items/item_primary', { method: 'DELETE' });
  assert(deleteItem.response.ok, 'conversation item delete should succeed');
  assert(deleteItem.json.deleted === true, 'conversation item delete should return deleted flag');
  assert(countHits(primary, (hit) => hit.path === '/conversations/conv_primary/items/item_primary' && hit.method === 'DELETE') === 1, 'conversation item delete should hit primary');

  primary.clear();
  secondary.clear();

  const deleteConversation = await request('/v1/conversations/conv_primary', { method: 'DELETE' });
  assert(deleteConversation.response.ok, 'conversation delete should succeed');
  assert(deleteConversation.json.deleted === true, 'conversation delete should return deleted flag');
  assert(countHits(primary, (hit) => hit.path === '/conversations/conv_primary' && hit.method === 'DELETE') === 1, 'conversation delete should hit primary');
  assert(countHits(secondary, (hit) => hit.path.startsWith('/conversations')) === 0, 'conversation routes should remain on default upstream');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'conversation utility routes use default upstream profile',
      'conversation create and update preserve JSON payloads',
      'conversation item routes preserve query string and JSON payloads',
      'conversation item CRUD routes stay on default upstream'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
