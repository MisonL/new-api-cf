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
    const body = rawBody ? JSON.parse(rawBody) : null;
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
