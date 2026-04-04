import { useEffect, useState, type FormEvent } from 'react';
import { fetchSession, fetchStatus, login, logout, type SessionData, type StatusData } from './api';

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
    title: 'Cloudflare Guardrails',
    body: '继续保持 Worker-first、轻状态、显式错误，不用静默降级掩盖未实现能力。'
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

export function App() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function refresh() {
    const [nextStatus, nextSession] = await Promise.all([fetchStatus(), fetchSession()]);
    setStatus(nextStatus);
    setSession(nextSession);
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
    try {
      await logout();
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'logout failed');
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [nextStatus, nextSession] = await Promise.all([fetchStatus(), fetchSession()]);
        if (!cancelled) {
          setStatus(nextStatus);
          setSession(nextSession);
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
          面向 10 人以内并发场景的 Cloudflare Free 版统一 AI 网关，当前已补最小 session 登录闭环。
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
                  session
                }
              : { message: loadError ?? 'loading' },
            null,
            2
          )}
        </pre>
      </section>

      <SessionPanel
        actionError={actionError}
        onLogin={handleLogin}
        onLogout={handleLogout}
        pending={pending}
        session={session}
        status={status}
      />

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
