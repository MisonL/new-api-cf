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
      search: url.search,
      body,
      rawBody,
      contentType: String(contentType),
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

    if (url.pathname.startsWith('/threads/') && url.pathname !== '/threads/runs') {
      const parts = url.pathname.split('/').filter(Boolean);
      const threadId = parts[1];
      const threadProfileId = threadId === 'thread_primary'
        ? 'primary'
        : (threadId === 'thread_secondary' || threadId === 'thread_legacy' ? 'secondary' : null);
      const threadSuffix = threadId === 'thread_primary'
        ? 'primary'
        : (threadId === 'thread_secondary' ? 'secondary' : (threadId === 'thread_legacy' ? 'legacy' : null));
      if (!threadProfileId || threadProfileId !== profileId) {
        return createResponse(res, 404, { error: { message: 'not found' } });
      }

      if (parts.length === 2 && req.method === 'GET') {
        return createResponse(res, 200, { id: threadId, object: 'thread' });
      }

      if (parts.length === 2 && req.method === 'POST') {
        return createResponse(res, 200, {
          id: threadId,
          object: 'thread',
          metadata: body?.metadata || {}
        });
      }

      if (parts.length === 2 && req.method === 'DELETE') {
        return createResponse(res, 200, {
          id: threadId,
          object: 'thread.deleted',
          deleted: true
        });
      }

      if (parts[2] === 'messages') {
        const messageId = `msg_${threadSuffix}`;
        if (parts.length === 3 && req.method === 'GET') {
          return createResponse(res, 200, {
            object: 'list',
            data: [{ id: messageId, object: 'thread.message', thread_id: threadId }]
          });
        }
        if (parts.length === 3 && req.method === 'POST') {
          return createResponse(res, 200, {
            id: messageId,
            object: 'thread.message',
            thread_id: threadId,
            role: body?.role || 'user',
            content: body?.content || []
          });
        }
        if (parts.length === 4 && parts[3] === messageId && req.method === 'GET') {
          return createResponse(res, 200, {
            id: messageId,
            object: 'thread.message',
            thread_id: threadId,
            role: 'user',
            content: [{ type: 'text', text: { value: `message-${threadSuffix}` } }]
          });
        }
        if (parts.length === 4 && parts[3] === messageId && req.method === 'POST') {
          return createResponse(res, 200, {
            id: messageId,
            object: 'thread.message',
            thread_id: threadId,
            metadata: body?.metadata || {}
          });
        }
        if (parts.length === 4 && parts[3] === messageId && req.method === 'DELETE') {
          return createResponse(res, 200, {
            id: messageId,
            object: 'thread.message.deleted',
            deleted: true
          });
        }
      }

      if (parts[2] === 'runs') {
        const runId = threadId === 'thread_secondary' ? 'run_secondary_followup' : `run_${threadSuffix}`;
        const stepId = `step_${threadSuffix}`;
        const assistantId = profileId === 'secondary' ? 'asst_secondary' : 'asst_primary';

        if (parts.length === 3 && req.method === 'POST') {
          return createResponse(res, 200, {
            id: runId,
            object: 'thread.run',
            assistant_id: body?.assistant_id || assistantId,
            thread_id: threadId,
            status: 'queued'
          });
        }
        if (parts.length === 3 && req.method === 'GET') {
          return createResponse(res, 200, {
            object: 'list',
            data: [{ id: runId, object: 'thread.run', thread_id: threadId }]
          });
        }
        if (parts.length === 4 && parts[3] === runId && req.method === 'GET') {
          return createResponse(res, 200, {
            id: runId,
            object: 'thread.run',
            assistant_id: assistantId,
            thread_id: threadId,
            status: 'queued'
          });
        }
        if (parts.length === 5 && parts[3] === runId && parts[4] === 'cancel' && req.method === 'POST') {
          return createResponse(res, 200, {
            id: runId,
            object: 'thread.run',
            thread_id: threadId,
            status: 'cancelling'
          });
        }
        if (parts.length === 5 && parts[3] === runId && parts[4] === 'submit_tool_outputs' && req.method === 'POST') {
          return createResponse(res, 200, {
            id: runId,
            object: 'thread.run',
            thread_id: threadId,
            status: 'queued'
          });
        }
        if (parts.length === 5 && parts[3] === runId && parts[4] === 'steps' && req.method === 'GET') {
          return createResponse(res, 200, {
            object: 'list',
            data: [{ id: stepId, object: 'thread.run.step', run_id: runId }]
          });
        }
        if (parts.length === 6 && parts[3] === runId && parts[4] === 'steps' && parts[5] === stepId && req.method === 'GET') {
          return createResponse(res, 200, {
            id: stepId,
            object: 'thread.run.step',
            run_id: runId,
            type: 'tool_calls'
          });
        }
      }

      return createResponse(res, 404, { error: { message: 'not found' } });
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

    if (req.method === 'POST' && url.pathname === '/realtime/client_secrets') {
      return createResponse(res, 200, {
        id: `secret_${profileId}`,
        object: 'realtime.client_secret',
        session: {
          model: body?.session?.model || 'unknown'
        },
        value: `rt_${profileId}`
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

    if (req.method === 'POST' && url.pathname === '/realtime/transcription_sessions') {
      return createResponse(res, 200, {
        id: `tsess_${profileId}`,
        object: 'realtime.transcription_session',
        input_audio_transcription: {
          model: body?.input_audio_transcription?.model || 'unknown'
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

    if (req.method === 'GET' && url.pathname === '/fine_tuning/jobs') {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: 'ftjob_123', object: 'fine_tuning.job', status: 'running', profile: profileId }]
      });
    }

    if (req.method === 'POST' && url.pathname === '/fine_tuning/jobs') {
      return createResponse(res, 200, {
        id: 'ftjob_created',
        object: 'fine_tuning.job',
        model: body?.model || 'unknown',
        training_file: body?.training_file || '',
        status: 'validating_files',
        profile: profileId
      });
    }

    if (req.method === 'GET' && url.pathname === '/fine_tuning/jobs/ftjob_123') {
      return createResponse(res, 200, {
        id: 'ftjob_123',
        object: 'fine_tuning.job',
        status: 'running',
        model: 'primary-model',
        profile: profileId
      });
    }

    if (req.method === 'POST' && url.pathname === '/fine_tuning/jobs/ftjob_123/cancel') {
      return createResponse(res, 200, {
        id: 'ftjob_123',
        object: 'fine_tuning.job',
        status: 'cancelled',
        profile: profileId
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

    if (req.method === 'GET' && url.pathname === '/fine_tuning/jobs/ftjob_123/events') {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: 'ftevent_1', object: 'fine_tuning.job.event', level: 'info', profile: profileId }]
      });
    }

    if (req.method === 'GET' && url.pathname === '/fine_tuning/jobs/ftjob_123/checkpoints') {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: 'ftckpt_123', object: 'fine_tuning.job.checkpoint', fine_tuned_model_checkpoint: 'ft:ckpt:123', profile: profileId }]
      });
    }

    if (req.method === 'GET' && url.pathname === '/fine_tuning/checkpoints/ftckpt_123/permissions') {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: 'perm_123', object: 'checkpoint.permission', profile: profileId }]
      });
    }

    if (req.method === 'POST' && url.pathname === '/fine_tuning/checkpoints/ftckpt_123/permissions') {
      return createResponse(res, 200, {
        id: 'perm_created',
        object: 'checkpoint.permission',
        profile: profileId
      });
    }

    if (req.method === 'DELETE' && url.pathname === '/fine_tuning/checkpoints/ftckpt_123/permissions/perm_123') {
      return createResponse(res, 200, {
        id: 'perm_123',
        object: 'checkpoint.permission.deleted',
        deleted: true,
        profile: profileId
      });
    }

    if (req.method === 'GET' && url.pathname === '/vector_stores') {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: `vs_${profileId}`, object: 'vector_store', name: `kb-${profileId}` }]
      });
    }

    if (req.method === 'POST' && url.pathname === '/vector_stores') {
      return createResponse(res, 200, {
        id: `vs_${profileId}`,
        object: 'vector_store',
        name: body?.name || ''
      });
    }

    if (req.method === 'GET' && url.pathname === `/vector_stores/vs_${profileId}`) {
      return createResponse(res, 200, {
        id: `vs_${profileId}`,
        object: 'vector_store',
        name: `kb-${profileId}`,
        metadata: {
          source: profileId
        }
      });
    }

    if (req.method === 'POST' && url.pathname === `/vector_stores/vs_${profileId}`) {
      return createResponse(res, 200, {
        id: `vs_${profileId}`,
        object: 'vector_store',
        name: body?.name || `kb-${profileId}`,
        metadata: body?.metadata || {}
      });
    }

    if (req.method === 'DELETE' && url.pathname === `/vector_stores/vs_${profileId}`) {
      return createResponse(res, 200, {
        id: `vs_${profileId}`,
        object: 'vector_store.deleted',
        deleted: true
      });
    }

    if (req.method === 'POST' && url.pathname === `/vector_stores/vs_${profileId}/search`) {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: `chunk_${profileId}`, object: 'vector_store.search_result' }]
      });
    }

    if (req.method === 'GET' && url.pathname === `/vector_stores/vs_${profileId}/files`) {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: `vsfile_${profileId}`, object: 'vector_store.file', vector_store_id: `vs_${profileId}` }]
      });
    }

    if (req.method === 'POST' && url.pathname === `/vector_stores/vs_${profileId}/files`) {
      return createResponse(res, 200, {
        id: `vsfile_${profileId}`,
        object: 'vector_store.file',
        vector_store_id: `vs_${profileId}`,
        file_id: body?.file_id || ''
      });
    }

    if (req.method === 'GET' && url.pathname === `/vector_stores/vs_${profileId}/files/vsfile_${profileId}`) {
      return createResponse(res, 200, {
        id: `vsfile_${profileId}`,
        object: 'vector_store.file',
        vector_store_id: `vs_${profileId}`,
        file_id: `file_${profileId}`
      });
    }

    if (req.method === 'GET' && url.pathname === `/vector_stores/vs_${profileId}/files/vsfile_${profileId}/content`) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`vector-store-file-content-${profileId}`);
      return;
    }

    if (req.method === 'POST' && url.pathname === `/vector_stores/vs_${profileId}/files/vsfile_${profileId}`) {
      return createResponse(res, 200, {
        id: `vsfile_${profileId}`,
        object: 'vector_store.file',
        vector_store_id: `vs_${profileId}`,
        attributes: body?.attributes || {}
      });
    }

    if (req.method === 'DELETE' && url.pathname === `/vector_stores/vs_${profileId}/files/vsfile_${profileId}`) {
      return createResponse(res, 200, {
        id: `vsfile_${profileId}`,
        object: 'vector_store.file.deleted',
        deleted: true
      });
    }

    if (req.method === 'GET' && url.pathname === `/vector_stores/vs_${profileId}/file_batches`) {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: `vsbatch_${profileId}`, object: 'vector_store.file_batch', status: 'in_progress' }]
      });
    }

    if (req.method === 'POST' && url.pathname === `/vector_stores/vs_${profileId}/file_batches`) {
      return createResponse(res, 200, {
        id: `vsbatch_${profileId}`,
        object: 'vector_store.file_batch',
        status: 'in_progress',
        vector_store_id: `vs_${profileId}`
      });
    }

    if (req.method === 'GET' && url.pathname === `/vector_stores/vs_${profileId}/file_batches/vsbatch_${profileId}`) {
      return createResponse(res, 200, {
        id: `vsbatch_${profileId}`,
        object: 'vector_store.file_batch',
        status: 'in_progress',
        vector_store_id: `vs_${profileId}`
      });
    }

    if (req.method === 'GET' && url.pathname === `/vector_stores/vs_${profileId}/file_batches/vsbatch_${profileId}/files`) {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: `vsfile_${profileId}`, object: 'vector_store.file' }]
      });
    }

    if (req.method === 'POST' && url.pathname === `/vector_stores/vs_${profileId}/file_batches/vsbatch_${profileId}/cancel`) {
      return createResponse(res, 200, {
        id: `vsbatch_${profileId}`,
        object: 'vector_store.file_batch',
        status: 'cancelled'
      });
    }

    if (req.method === 'POST' && url.pathname === '/uploads') {
      return createResponse(res, 200, {
        id: `upload_${profileId}`,
        object: 'upload',
        status: 'pending'
      });
    }

    if (req.method === 'GET' && url.pathname === `/uploads/upload_${profileId}`) {
      return createResponse(res, 200, {
        id: `upload_${profileId}`,
        object: 'upload',
        status: 'pending'
      });
    }

    if (req.method === 'GET' && url.pathname === `/uploads/upload_${profileId}/parts`) {
      return createResponse(res, 200, {
        object: 'list',
        data: [{
          id: `part_${profileId}`,
          object: 'upload.part',
          upload_id: `upload_${profileId}`
        }]
      });
    }

    if (req.method === 'POST' && url.pathname === `/uploads/upload_${profileId}/parts`) {
      return createResponse(res, 200, {
        id: `part_${profileId}`,
        object: 'upload.part',
        upload_id: `upload_${profileId}`
      });
    }

    if (req.method === 'GET' && url.pathname === `/uploads/upload_${profileId}/parts/part_${profileId}`) {
      return createResponse(res, 200, {
        id: `part_${profileId}`,
        object: 'upload.part',
        upload_id: `upload_${profileId}`
      });
    }

    if (req.method === 'POST' && url.pathname === `/uploads/upload_${profileId}/complete`) {
      return createResponse(res, 200, {
        id: `upload_${profileId}`,
        object: 'upload',
        status: 'completed'
      });
    }

    if (req.method === 'POST' && url.pathname === `/uploads/upload_cancel_${profileId}/cancel`) {
      return createResponse(res, 200, {
        id: `upload_cancel_${profileId}`,
        object: 'upload',
        status: 'cancelled'
      });
    }

    if (req.method === 'POST' && url.pathname === '/files') {
      return createResponse(res, 200, {
        id: `file_${profileId}`,
        object: 'file',
        purpose: 'assistants'
      });
    }

    if (req.method === 'GET' && url.pathname === '/files') {
      return createResponse(res, 200, {
        object: 'list',
        data: [{
          id: `file_${profileId}`,
          object: 'file',
          purpose: 'assistants',
          filename: `file-${profileId}.txt`
        }]
      });
    }

    if (req.method === 'GET' && url.pathname === `/files/file_${profileId}`) {
      return createResponse(res, 200, {
        id: `file_${profileId}`,
        object: 'file',
        purpose: 'assistants',
        bytes: 11,
        metadata: {
          source: profileId
        }
      });
    }

    if (req.method === 'GET' && url.pathname === `/files/file_${profileId}/content`) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`file-content-${profileId}`);
      return;
    }

    if (req.method === 'DELETE' && url.pathname === `/files/file_${profileId}`) {
      return createResponse(res, 200, {
        id: `file_${profileId}`,
        object: 'file.deleted',
        deleted: true
      });
    }

    if (req.method === 'GET' && url.pathname === '/batches') {
      return createResponse(res, 200, {
        object: 'list',
        data: [{
          id: `batch_${profileId}`,
          object: 'batch',
          endpoint: '/v1/responses',
          status: 'validating'
        }]
      });
    }

    if (req.method === 'POST' && url.pathname === '/batches') {
      return createResponse(res, 200, {
        id: `batch_${profileId}`,
        object: 'batch',
        status: 'validating',
        endpoint: body?.endpoint || '/v1/responses',
        metadata: body?.metadata || {}
      });
    }

    if (req.method === 'GET' && url.pathname === `/batches/batch_${profileId}`) {
      return createResponse(res, 200, {
        id: `batch_${profileId}`,
        object: 'batch',
        status: 'validating',
        endpoint: '/v1/responses',
        metadata: {
          source: profileId
        }
      });
    }

    if (req.method === 'POST' && url.pathname === `/batches/batch_${profileId}/cancel`) {
      return createResponse(res, 200, {
        id: `batch_${profileId}`,
        object: 'batch',
        status: 'cancelling'
      });
    }

    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      return createResponse(res, 200, {
        id: `chatcmpl_${profileId}`,
        object: 'chat.completion',
        created: 1234567890,
        model: body?.model || 'unknown',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: `chat-${profileId}`
            },
            finish_reason: 'stop'
          }
        ]
      });
    }

    if (req.method === 'POST' && url.pathname === '/completions') {
      return createResponse(res, 200, {
        id: `cmpl_${profileId}`,
        object: 'text_completion',
        created: 1234567890,
        model: body?.model || 'unknown',
        choices: [
          {
            index: 0,
            text: `completion-${profileId}`,
            finish_reason: 'stop'
          }
        ]
      });
    }

    if (req.method === 'POST' && url.pathname === '/embeddings') {
      return createResponse(res, 200, {
        object: 'list',
        data: [
          {
            object: 'embedding',
            index: 0,
            embedding: [0.1, 0.2, 0.3]
          }
        ],
        model: body?.model || 'unknown'
      });
    }

    if (req.method === 'POST' && url.pathname === '/moderations') {
      return createResponse(res, 200, {
        id: `modr_${profileId}`,
        model: body?.model || 'unknown',
        results: [
          {
            flagged: false
          }
        ]
      });
    }

    if (req.method === 'POST' && url.pathname === '/audio/speech') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(`speech-${profileId}`);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/audio/transcriptions') {
      return createResponse(res, 200, {
        text: `transcription-${profileId}`
      });
    }

    if (req.method === 'POST' && url.pathname === '/audio/translations') {
      return createResponse(res, 200, {
        text: `translation-${profileId}`
      });
    }

    if (req.method === 'POST' && url.pathname === '/images/generations') {
      return createResponse(res, 200, {
        created: 1234567890,
        data: [
          {
            url: `https://example.com/${profileId}.png`
          }
        ]
      });
    }

    if (req.method === 'POST' && url.pathname === '/images/edits') {
      return createResponse(res, 200, {
        created: 1234567890,
        data: [
          {
            url: `https://example.com/edit-${profileId}.png`
          }
        ]
      });
    }

    if (req.method === 'POST' && url.pathname === '/images/variations') {
      return createResponse(res, 200, {
        created: 1234567890,
        data: [
          {
            url: `https://example.com/variation-${profileId}.png`
          }
        ]
      });
    }

    if (req.method === 'POST' && url.pathname === '/conversations') {
      return createResponse(res, 200, {
        id: `conv_${profileId}`,
        object: 'conversation',
        metadata: body?.metadata || {}
      });
    }

    if (req.method === 'GET' && url.pathname === `/conversations/conv_${profileId}`) {
      return createResponse(res, 200, {
        id: `conv_${profileId}`,
        object: 'conversation',
        metadata: {
          source: profileId
        }
      });
    }

    if (req.method === 'POST' && url.pathname === `/conversations/conv_${profileId}`) {
      return createResponse(res, 200, {
        id: `conv_${profileId}`,
        object: 'conversation',
        metadata: body?.metadata || {}
      });
    }

    if (req.method === 'DELETE' && url.pathname === `/conversations/conv_${profileId}`) {
      return createResponse(res, 200, {
        id: `conv_${profileId}`,
        object: 'conversation.deleted',
        deleted: true
      });
    }

    if (req.method === 'GET' && url.pathname === `/conversations/conv_${profileId}/items`) {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: `item_${profileId}`, object: 'conversation.item' }]
      });
    }

    if (req.method === 'POST' && url.pathname === `/conversations/conv_${profileId}/items`) {
      return createResponse(res, 200, {
        object: 'list',
        data: [{ id: `item_${profileId}`, object: 'conversation.item' }]
      });
    }

    if (req.method === 'GET' && url.pathname === `/conversations/conv_${profileId}/items/item_${profileId}`) {
      return createResponse(res, 200, {
        id: `item_${profileId}`,
        object: 'conversation.item'
      });
    }

    if (req.method === 'DELETE' && url.pathname === `/conversations/conv_${profileId}/items/item_${profileId}`) {
      return createResponse(res, 200, {
        id: `item_${profileId}`,
        object: 'conversation.item.deleted',
        deleted: true
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
