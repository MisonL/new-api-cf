import { useEffect, useState, type FormEvent } from 'react';
import {
  fetchModels,
  fetchSession,
  fetchStatus,
  login,
  logout,
  sendChatCompletion,
  type ChatCompletionResponse,
  type ModelListData,
  type SessionData,
  type StatusData
} from './api';

const capabilityCards = [
  {
    title: 'OpenAI-Compatible Relay',
    body: '当前主链已经提供 /v1/models 与 /v1/chat/completions，未配置上游时会显式失败。'
  },
  {
    title: 'Session Login',
    body: '支持最小 admin token 登录换取签名 cookie，会话由 Worker 使用 HMAC 进行校验。'
  },
  {
    title: 'Request Guardrails',
    body: 'Worker 现在具备 request id 和上游超时控制，便于后续接入日志、限流和审计。'
  }
];

function SessionPanel(props: {
  status: StatusData | null;
  session: SessionData | null;
  pending: boolean;
  actionError: string | null;
  onLogin: (token: string) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const { status, session, pending, actionError, onLogin, onLogout } = props;
  const [token, setToken] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onLogin(token);
    setToken('');
  }

  if (!status) {
    return null;
  }

  if (status.authMode === 'disabled') {
    return (
      <section className="panel panel-soft">
        <h2>认证状态</h2>
        <p>当前为 `AUTH_MODE=disabled`，管理端不要求登录。</p>
      </section>
    );
  }

  if (status.authMode === 'bearer') {
    return (
      <section className="panel panel-soft">
        <h2>认证状态</h2>
        <p>当前为 `AUTH_MODE=bearer`，需直接通过请求头访问保护接口。</p>
      </section>
    );
  }

  return (
    <section className="panel panel-soft">
      <div className="panel-header">
        <h2>登录面板</h2>
        {session?.authenticated ? <span className="badge">session active</span> : null}
      </div>
      {session?.authenticated ? (
        <div className="stack">
          <p>当前已登录：admin</p>
          <button className="action" disabled={pending} onClick={() => void onLogout()} type="button">
            退出登录
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={(event) => void handleSubmit(event)}>
          <label className="label" htmlFor="admin-token">
            输入 ADMIN_BEARER_TOKEN 以换取 session cookie
          </label>
          <input
            id="admin-token"
            className="input"
            disabled={pending}
            onChange={(event) => setToken(event.target.value)}
            placeholder="admin bootstrap token"
            type="password"
            value={token}
          />
          <button className="action" disabled={pending || token.length === 0} type="submit">
            {pending ? '登录中...' : '登录'}
          </button>
        </form>
      )}
      {actionError ? <p className="error-text">{actionError}</p> : null}
    </section>
  );
}

function PlaygroundPanel(props: {
  status: StatusData | null;
  models: ModelListData | null;
  modelsError: string | null;
  pending: boolean;
  chatResult: ChatCompletionResponse | null;
  chatError: string | null;
  onReloadModels: () => Promise<void>;
  onSend: (input: { model: string; prompt: string; systemPrompt: string }) => Promise<void>;
}) {
  const { status, models, modelsError, pending, chatResult, chatError, onReloadModels, onSend } = props;
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('用一句话说明你是一个 Cloudflare 上运行的最小 AI 网关。');
  const [systemPrompt, setSystemPrompt] = useState('你是一个简洁的系统说明助手。');

  useEffect(() => {
    if (!model && models && models.data.length > 0) {
      setModel(models.data[0].id);
    }
  }, [model, models]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSend({
      model,
      prompt,
      systemPrompt
    });
  }

  if (!status) {
    return null;
  }

  return (
    <section className="panel panel-soft">
      <div className="panel-header">
        <h2>Relay Playground</h2>
        <span className={`badge ${status.upstreamConfigured ? '' : 'badge-error'}`}>
          {status.upstreamConfigured ? 'upstream ready' : 'upstream missing'}
        </span>
      </div>
      <div className="stack">
        <div className="toolbar">
          <button className="action action-secondary" disabled={pending} onClick={() => void onReloadModels()} type="button">
            刷新模型
          </button>
          <span className="meta-text">timeout {status.upstreamTimeoutMs} ms</span>
        </div>
        {modelsError ? <p className="error-text">{modelsError}</p> : null}
        <form className="stack" onSubmit={(event) => void handleSubmit(event)}>
          <label className="label" htmlFor="model-select">
            模型
          </label>
          <select
            id="model-select"
            className="input"
            disabled={pending || !models || models.data.length === 0}
            onChange={(event) => setModel(event.target.value)}
            value={model}
          >
            <option value="">请选择模型</option>
            {(models?.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
          <label className="label" htmlFor="system-prompt">
            System Prompt
          </label>
          <textarea
            id="system-prompt"
            className="input textarea"
            disabled={pending}
            onChange={(event) => setSystemPrompt(event.target.value)}
            value={systemPrompt}
          />
          <label className="label" htmlFor="user-prompt">
            User Prompt
          </label>
          <textarea
            id="user-prompt"
            className="input textarea"
            disabled={pending}
            onChange={(event) => setPrompt(event.target.value)}
            value={prompt}
          />
          <button className="action" disabled={pending || !model || prompt.trim().length === 0} type="submit">
            {pending ? '请求中...' : '发送请求'}
          </button>
        </form>
        {chatError ? <p className="error-text">{chatError}</p> : null}
        <pre className="status-block status-block-soft">
          {JSON.stringify(chatResult ?? { message: '尚未发送请求' }, null, 2)}
        </pre>
      </div>
    </section>
  );
}

export function App() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);
  const [models, setModels] = useState<ModelListData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatResult, setChatResult] = useState<ChatCompletionResponse | null>(null);
  const [pending, setPending] = useState(false);

  async function refresh() {
    const [nextStatus, nextSession] = await Promise.all([fetchStatus(), fetchSession()]);
    setStatus(nextStatus);
    setSession(nextSession);
  }

  async function loadModels() {
    setModelsError(null);
    try {
      const nextModels = await fetchModels();
      setModels(nextModels);
    } catch (cause) {
      setModels(null);
      setModelsError(cause instanceof Error ? cause.message : 'failed to load models');
    }
  }

  async function handleLogin(token: string) {
    setPending(true);
    setActionError(null);
    try {
      await login(token);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'login failed');
    } finally {
      setPending(false);
    }
  }

  async function handleLogout() {
    setPending(true);
    setActionError(null);
    setChatError(null);
    try {
      await logout();
      setChatResult(null);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'logout failed');
    } finally {
      setPending(false);
    }
  }

  async function handleSend(input: { model: string; prompt: string; systemPrompt: string }) {
    setPending(true);
    setChatError(null);
    try {
      const result = await sendChatCompletion(input);
      setChatResult(result);
    } catch (cause) {
      setChatResult(null);
      setChatError(cause instanceof Error ? cause.message : 'chat request failed');
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [nextStatus, nextSession] = await Promise.all([fetchStatus(), fetchSession()]);
        if (cancelled) {
          return;
        }

        setStatus(nextStatus);
        setSession(nextSession);

        try {
          const nextModels = await fetchModels();
          if (!cancelled) {
            setModels(nextModels);
          }
        } catch (cause) {
          if (!cancelled) {
            setModelsError(cause instanceof Error ? cause.message : 'failed to load models');
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setLoadError(cause instanceof Error ? cause.message : 'bootstrap failed');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cloudflare Worker-first Skeleton</p>
        <h1>new-api-cf</h1>
        <p className="lede">
          面向 10 人以内并发场景的 Cloudflare Free 版统一 AI 网关，当前已具备登录、模型读取和最小 chat playground。
        </p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Worker 状态</h2>
          {loadError ? <span className="badge badge-error">fetch failed</span> : null}
          {status ? <span className="badge">online</span> : null}
        </div>
        <pre className="status-block">
          {JSON.stringify(
            status
              ? {
                  ...status,
                  session,
                  modelCount: models?.data.length ?? 0
                }
              : { message: loadError ?? 'loading' },
            null,
            2
          )}
        </pre>
      </section>

      <div className="grid grid-two">
        <SessionPanel
          actionError={actionError}
          onLogin={handleLogin}
          onLogout={handleLogout}
          pending={pending}
          session={session}
          status={status}
        />
        <PlaygroundPanel
          chatError={chatError}
          chatResult={chatResult}
          models={models}
          modelsError={modelsError}
          onReloadModels={loadModels}
          onSend={handleSend}
          pending={pending}
          status={status}
        />
      </div>

      <section className="grid">
        {capabilityCards.map((item) => (
          <article className="card" key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
