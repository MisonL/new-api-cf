import { useEffect, useState } from 'react';

type StatusResponse = {
  success: boolean;
  data?: {
    runtime: string;
    environment: string;
    mode: string;
    authMode: string;
    upstreamConfigured: boolean;
  };
};

const capabilityCards = [
  {
    title: 'Edge API',
    body: 'Hono Worker 负责状态、认证门面、模型列表和最小 relay 主链。'
  },
  {
    title: 'Shared Contracts',
    body: '共享 DTO 和错误模型集中在 monorepo 包内，避免前后端契约漂移。'
  },
  {
    title: 'Free-Tier Guardrails',
    body: '当前骨架只保留轻量主链，不伪造账务、日志和后台任务。'
  }
];

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      try {
        const response = await fetch('/api/status');
        const payload = (await response.json()) as StatusResponse;
        if (!cancelled) {
          setStatus(payload);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'status fetch failed');
        }
      }
    }

    void loadStatus();

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
          面向 10 人以内并发场景的 Cloudflare Free 版统一 AI 网关骨架。
        </p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Worker 状态</h2>
          {error ? <span className="badge badge-error">fetch failed</span> : null}
          {status?.success ? <span className="badge">online</span> : null}
        </div>
        <pre className="status-block">
          {JSON.stringify(status?.data ?? { message: error ?? 'loading' }, null, 2)}
        </pre>
      </section>

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

