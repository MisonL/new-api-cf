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
    name: 'new-api-cf-edge-api-core-relay-integration',
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

  const chat = await request('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      messages: [{ role: 'user', content: 'hello' }]
    })
  });
  assert(chat.response.ok, 'chat completion should succeed');
  assert(chat.json.choices[0].message.content === 'chat-secondary', 'chat completion should route to secondary upstream');
  assert(countHits(primary, (hit) => hit.path === '/chat/completions') === 0, 'chat completion should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/chat/completions') === 1, 'chat completion should hit secondary');

  primary.clear();
  secondary.clear();

  const chatStream = await request('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      stream: true,
      messages: [{ role: 'user', content: 'stream hello' }]
    })
  });
  assert(chatStream.response.ok, 'streaming chat completion should succeed');
  assert((chatStream.response.headers.get('content-type') || '').includes('text/event-stream'), 'streaming chat completion should preserve sse content type');
  assert(chatStream.text.includes('data: {"id":"chatcmpl_secondary"'), 'streaming chat completion should preserve sse chunk payload');
  assert(chatStream.text.includes('data: [DONE]'), 'streaming chat completion should preserve sse terminator');
  assert(countHits(primary, (hit) => hit.path === '/chat/completions') === 0, 'streaming chat completion should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/chat/completions' && hit.body?.stream === true) === 1, 'streaming chat completion should hit secondary with stream flag');

  primary.clear();
  secondary.clear();

  const completion = await request('/v1/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      prompt: 'hello'
    })
  });
  assert(completion.response.ok, 'completion should succeed');
  assert(completion.json.choices[0].text === 'completion-secondary', 'completion should route to secondary upstream');
  assert(countHits(secondary, (hit) => hit.path === '/completions') === 1, 'completion should hit secondary');

  primary.clear();
  secondary.clear();

  const completionStream = await request('/v1/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      stream: true,
      prompt: 'stream hello'
    })
  });
  assert(completionStream.response.ok, 'streaming completion should succeed');
  assert((completionStream.response.headers.get('content-type') || '').includes('text/event-stream'), 'streaming completion should preserve sse content type');
  assert(completionStream.text.includes('data: {"id":"cmpl_secondary"'), 'streaming completion should preserve sse chunk payload');
  assert(completionStream.text.includes('data: [DONE]'), 'streaming completion should preserve sse terminator');
  assert(countHits(primary, (hit) => hit.path === '/completions') === 0, 'streaming completion should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/completions' && hit.body?.stream === true) === 1, 'streaming completion should hit secondary with stream flag');

  primary.clear();
  secondary.clear();

  const responseStream = await request('/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      stream: true,
      input: 'stream hello'
    })
  });
  assert(responseStream.response.ok, 'streaming response create should succeed');
  assert((responseStream.response.headers.get('content-type') || '').includes('text/event-stream'), 'streaming response create should preserve sse content type');
  assert(responseStream.text.includes('data: {"type":"response.created"'), 'streaming response create should preserve sse chunk payload');
  assert(responseStream.text.includes('data: [DONE]'), 'streaming response create should preserve sse terminator');
  assert(countHits(primary, (hit) => hit.path === '/responses') === 0, 'streaming response create should not hit primary');
  assert(countHits(secondary, (hit) => hit.path === '/responses' && hit.body?.stream === true) === 1, 'streaming response create should hit secondary with stream flag');

  primary.clear();
  secondary.clear();

  const embeddings = await request('/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      input: 'hello'
    })
  });
  assert(embeddings.response.ok, 'embeddings should succeed');
  assert(embeddings.json.model === 'secondary-model', 'embeddings should preserve requested model');
  assert(countHits(secondary, (hit) => hit.path === '/embeddings') === 1, 'embeddings should hit secondary');

  primary.clear();
  secondary.clear();

  const moderations = await request('/v1/moderations', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      input: 'hello'
    })
  });
  assert(moderations.response.ok, 'moderations should succeed');
  assert(moderations.json.results[0].flagged === false, 'moderations should preserve upstream payload');
  assert(countHits(secondary, (hit) => hit.path === '/moderations') === 1, 'moderations should hit secondary');

  primary.clear();
  secondary.clear();

  const speech = await request('/v1/audio/speech', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      input: 'hello',
      voice: 'alloy'
    })
  });
  assert(speech.response.ok, 'speech should succeed');
  assert(speech.text === 'speech-secondary', 'speech should preserve raw upstream audio response');
  assert((speech.response.headers.get('content-type') || '').includes('audio/mpeg'), 'speech should preserve upstream content type');
  assert(countHits(secondary, (hit) => hit.path === '/audio/speech') === 1, 'speech should hit secondary');

  primary.clear();
  secondary.clear();

  const transcriptionBody = new FormData();
  transcriptionBody.set('model', 'secondary-model');
  transcriptionBody.set('file', new Blob(['transcription sample'], { type: 'audio/wav' }), 'sample.wav');
  transcriptionBody.set('language', 'zh');
  const transcription = await request('/v1/audio/transcriptions', {
    method: 'POST',
    body: transcriptionBody
  });
  assert(transcription.response.ok, 'transcription should succeed');
  assert(transcription.json.text === 'transcription-secondary', 'transcription should route to secondary upstream');
  assert(countHits(secondary, (hit) => hit.path === '/audio/transcriptions' && hit.contentType.includes('multipart/form-data') && hit.rawBody.includes('transcription sample')) === 1, 'transcription should preserve multipart payload');

  primary.clear();
  secondary.clear();

  const translationBody = new FormData();
  translationBody.set('model', 'secondary-model');
  translationBody.set('file', new Blob(['translation sample'], { type: 'audio/wav' }), 'sample.wav');
  const translation = await request('/v1/audio/translations', {
    method: 'POST',
    body: translationBody
  });
  assert(translation.response.ok, 'translation should succeed');
  assert(translation.json.text === 'translation-secondary', 'translation should route to secondary upstream');
  assert(countHits(secondary, (hit) => hit.path === '/audio/translations' && hit.rawBody.includes('translation sample')) === 1, 'translation should preserve multipart payload');

  primary.clear();
  secondary.clear();

  const imageGeneration = await request('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({
      model: 'secondary-model',
      prompt: 'hello image'
    })
  });
  assert(imageGeneration.response.ok, 'image generation should succeed');
  assert(imageGeneration.json.data[0].url === 'https://example.com/secondary.png', 'image generation should route to secondary upstream');
  assert(countHits(secondary, (hit) => hit.path === '/images/generations') === 1, 'image generation should hit secondary');

  primary.clear();
  secondary.clear();

  const imageEditBody = new FormData();
  imageEditBody.set('model', 'secondary-model');
  imageEditBody.set('prompt', 'edit image');
  imageEditBody.set('image', new Blob(['edit image bytes'], { type: 'image/png' }), 'edit.png');
  const imageEdit = await request('/v1/images/edits', {
    method: 'POST',
    body: imageEditBody
  });
  assert(imageEdit.response.ok, 'image edit should succeed');
  assert(imageEdit.json.data[0].url === 'https://example.com/edit-secondary.png', 'image edit should route to secondary upstream');
  assert(countHits(secondary, (hit) => hit.path === '/images/edits' && hit.rawBody.includes('edit image bytes')) === 1, 'image edit should preserve multipart payload');

  primary.clear();
  secondary.clear();

  const imageVariationBody = new FormData();
  imageVariationBody.set('model', 'secondary-model');
  imageVariationBody.set('image', new Blob(['variation image bytes'], { type: 'image/png' }), 'variation.png');
  const imageVariation = await request('/v1/images/variations', {
    method: 'POST',
    body: imageVariationBody
  });
  assert(imageVariation.response.ok, 'image variation should succeed');
  assert(imageVariation.json.data[0].url === 'https://example.com/variation-secondary.png', 'image variation should route to secondary upstream');
  assert(countHits(secondary, (hit) => hit.path === '/images/variations' && hit.rawBody.includes('variation image bytes')) === 1, 'image variation should preserve multipart payload');
  assert(countHits(primary, (hit) => ['/audio/speech', '/audio/transcriptions', '/audio/translations', '/images/generations', '/images/edits', '/images/variations', '/chat/completions', '/completions', '/embeddings', '/moderations'].includes(hit.path)) === 0, 'model-routed relay endpoints should not hit primary for secondary model');

  console.log(JSON.stringify({
    ok: true,
    verified: [
      'chat completions route by model',
      'chat completions preserve sse passthrough',
      'completions route by model',
      'completions preserve sse passthrough',
      'responses preserve sse passthrough',
      'embeddings and moderations route by model',
      'audio speech preserves raw upstream response',
      'audio transcription and translation preserve multipart payloads',
      'image generation, edit, and variation route by model and preserve multipart payloads'
    ]
  }, null, 2));
} finally {
  await stopChild(worker);
  await Promise.allSettled([primary.stop(), secondary.stop()]);
  await rm(tempDir, { recursive: true, force: true });
}
