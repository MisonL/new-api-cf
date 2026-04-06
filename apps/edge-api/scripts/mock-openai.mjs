import http from 'node:http';

function createResponse(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createMockServer(profileId, port) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const rawBody = await collectBody(req);
    const contentType = req.headers['content-type'] || '';
    const body = rawBody && String(contentType).includes('application/json')
      ? JSON.parse(rawBody)
      : null;
    hits.push({
      profileId,
      method: req.method || 'GET',
      path: url.pathname,
      body,
      openaiBeta: req.headers['openai-beta'] || '',
      authorization: req.headers.authorization || ''
    });

    if (req.method === 'POST' && url.pathname === '/assistants') {
      const id = profileId === 'secondary' ? 'asst_secondary' : 'asst_primary';
      return createResponse(res, 200, { id, object: 'assistant', model: body?.model || 'unknown' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/models/')) {
      const model = url.pathname.split('/').pop();
      return createResponse(res, 200, {
        id: model,
        object: 'model',
        owned_by: profileId
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/assistants/')) {
      const assistantId = url.pathname.split('/').pop();
      if (assistantId === 'asst_secondary' && profileId === 'secondary') {
        return createResponse(res, 200, { id: assistantId, object: 'assistant', model: 'secondary-model' });
      }
      if (assistantId === 'asst_legacy' && profileId === 'secondary') {
        return createResponse(res, 200, { id: assistantId, object: 'assistant', model: 'secondary-model' });
      }
      return createResponse(res, 404, { error: { message: 'not found' } });
    }

    if (req.method === 'POST' && url.pathname === '/threads') {
      const id = profileId === 'primary' ? 'thread_primary' : 'thread_secondary';
      return createResponse(res, 200, { id, object: 'thread' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/threads/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const threadId = parts[1];
      if (parts.length === 2) {
        if (threadId === 'thread_primary' && profileId === 'primary') {
          return createResponse(res, 200, { id: threadId, object: 'thread' });
        }
        if (threadId === 'thread_secondary' && profileId === 'secondary') {
          return createResponse(res, 200, { id: threadId, object: 'thread' });
        }
        return createResponse(res, 404, { error: { message: 'not found' } });
      }
    }

    if (req.method === 'POST' && url.pathname === '/threads/runs') {
      const assistantId = body?.assistant_id;
      if (profileId === 'secondary' && (assistantId === 'asst_secondary' || assistantId === 'asst_legacy')) {
        return createResponse(res, 200, {
          id: 'run_secondary',
          object: 'thread.run',
          assistant_id: assistantId,
          thread_id: 'thread_secondary',
          status: 'queued'
        });
      }
      return createResponse(res, 404, { error: { message: 'not found' } });
    }

    if (req.method === 'POST' && url.pathname === '/threads/thread_secondary/runs' && profileId === 'secondary') {
      return createResponse(res, 200, {
        id: 'run_secondary_followup',
        object: 'thread.run',
        assistant_id: body?.assistant_id || 'asst_secondary',
        thread_id: 'thread_secondary',
        status: 'queued'
      });
    }

    if (req.method === 'POST' && url.pathname === '/realtime/sessions') {
      return createResponse(res, 200, {
        id: `sess_${profileId}`,
        object: 'realtime.session',
        model: body?.model || 'unknown',
        client_secret: {
          value: `ek_${profileId}`,
          expires_at: 1234567890
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/realtime/calls') {
      res.writeHead(201, {
        'content-type': 'application/sdp',
        location: `/v1/realtime/calls/call_${profileId}`
      });
      res.end(`answer-${profileId}`);
      return;
    }

    if (req.method === 'POST' && url.pathname === `/realtime/calls/call_${profileId}/accept`) {
      return createResponse(res, 200, { accepted: true, profile: profileId, model: body?.model || 'unknown' });
    }

    if (req.method === 'POST' && url.pathname === `/realtime/calls/call_${profileId}/hangup`) {
      return createResponse(res, 200, { hung_up: true, profile: profileId });
    }

    if (req.method === 'POST' && url.pathname === `/realtime/calls/call_${profileId}/refer`) {
      return createResponse(res, 200, { referred: true, profile: profileId, target_uri: body?.target_uri || '' });
    }

    if (req.method === 'POST' && url.pathname === `/realtime/calls/call_${profileId}/reject`) {
      return createResponse(res, 200, { rejected: true, profile: profileId, status_code: body?.status_code || 603 });
    }

    if (req.method === 'POST' && url.pathname === '/responses') {
      if (body?.previous_response_id === 'resp_secondary' && profileId === 'secondary') {
        return createResponse(res, 200, {
          id: 'resp_secondary_followup',
          object: 'response',
          model: body?.model || 'unknown',
          previous_response_id: body.previous_response_id
        });
      }
      if (body?.previous_response_id === 'resp_legacy' && profileId === 'secondary') {
        return createResponse(res, 200, {
          id: 'resp_legacy_followup',
          object: 'response',
          model: body?.model || 'unknown',
          previous_response_id: body.previous_response_id
        });
      }
      return createResponse(res, 200, {
        id: `resp_${profileId}`,
        object: 'response',
        model: body?.model || 'unknown'
      });
    }

    if (req.method === 'GET' && url.pathname === `/responses/resp_${profileId}`) {
      return createResponse(res, 200, {
        id: `resp_${profileId}`,
        object: 'response',
        model: `${profileId}-model`
      });
    }

    if (req.method === 'GET' && url.pathname === '/responses/resp_legacy' && profileId === 'secondary') {
      return createResponse(res, 200, {
        id: 'resp_legacy',
        object: 'response',
        model: 'secondary-model'
      });
    }

    if (req.method === 'GET' && url.pathname === `/responses/resp_${profileId}/input_items`) {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: `item_${profileId}`, object: 'response.input_item' }]
      });
    }

    if (req.method === 'GET' && url.pathname === '/responses/resp_legacy/input_items' && profileId === 'secondary') {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: 'item_legacy', object: 'response.input_item' }]
      });
    }

    if (req.method === 'POST' && url.pathname === `/responses/resp_${profileId}/cancel`) {
      return createResponse(res, 200, {
        id: `resp_${profileId}`,
        object: 'response',
        status: 'cancelled'
      });
    }

    if (req.method === 'POST' && url.pathname === '/responses/resp_legacy/cancel' && profileId === 'secondary') {
      return createResponse(res, 200, {
        id: 'resp_legacy',
        object: 'response',
        status: 'cancelled'
      });
    }

    if (req.method === 'DELETE' && url.pathname === `/responses/resp_${profileId}`) {
      return createResponse(res, 200, {
        id: `resp_${profileId}`,
        object: 'response.deleted',
        deleted: true
      });
    }

    if (req.method === 'DELETE' && url.pathname === '/responses/resp_legacy' && profileId === 'secondary') {
      return createResponse(res, 200, {
        id: 'resp_legacy',
        object: 'response.deleted',
        deleted: true
      });
    }

    if (req.method === 'POST' && url.pathname === '/fine_tuning/jobs/ftjob_123/pause') {
      return createResponse(res, 200, {
        id: 'ftjob_123',
        object: 'fine_tuning.job',
        status: 'paused',
        profile: profileId
      });
    }

    if (req.method === 'POST' && url.pathname === '/fine_tuning/jobs/ftjob_123/resume') {
      return createResponse(res, 200, {
        id: 'ftjob_123',
        object: 'fine_tuning.job',
        status: 'running',
        profile: profileId
      });
    }

    return createResponse(res, 404, { error: { message: 'unhandled route', path: url.pathname } });
  });

  return {
    hits,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    },
    async stop() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    clear() {
      hits.length = 0;
    }
  };
}
