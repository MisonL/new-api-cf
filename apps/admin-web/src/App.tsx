import { useEffect, useState, type FormEvent } from 'react';
import {
  bootstrapAdminState,
  createAdminToken,
  deleteAdminToken,
  fetchAdminState,
  fetchAdminTokens,
  fetchAdminUsage,
  getStoredAdminJwt,
  fetchModels,
  fetchSession,
  fetchStatus,
  login,
  logout,
  saveAdminSettings,
  sendChatCompletion,
  sendCompletionCreate,
  sendEmbeddingsCreate,
  sendModerationsCreate,
  sendResponseCreate,
  clearStoredAdminJwt,
  storeAdminJwt,
  updateAdminToken,
  updateAdminModel,
  type AdminState,
  type ApiTokenCreateResult,
  type ApiTokenDescriptor,
  type ChatCompletionResponse,
  type CompletionCreateResult,
  type EmbeddingsCreateResult,
  type ModelListData,
  type ModerationsCreateResult,
  type ResponseCreateResult,
  type SessionData,
  type StatusData,
  type UsageOverview
} from './api';

const capabilityCards = [
  {
    title: 'OpenAI-Compatible Relay',
    body: '当前主链已经提供 /v1/models、/v1/chat/completions、/v1/completions、/v1/embeddings、/v1/moderations 与 /v1/responses，未配置上游时会显式失败。'
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
  initialJwtToken: string;
  onLogin: (token: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onApplyJwt: (token: string) => Promise<void>;
  onClearJwt: () => Promise<void>;
}) {
  const { status, session, pending, actionError, initialJwtToken, onLogin, onLogout, onApplyJwt, onClearJwt } = props;
  const [token, setToken] = useState('');
  const [jwtToken, setJwtToken] = useState(initialJwtToken);

  useEffect(() => {
    setJwtToken(initialJwtToken);
  }, [initialJwtToken]);

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

  if (status.authMode === 'jwt') {
    return (
      <section className="panel panel-soft">
        <div className="panel-header">
          <h2>JWT 管理认证</h2>
          {session?.authenticated ? <span className="badge">jwt active</span> : null}
        </div>
        <div className="stack">
          <p>当前为 `AUTH_MODE=jwt`，管理接口通过 Bearer JWT 校验。</p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void onApplyJwt(jwtToken);
            }}
          >
            <label className="label" htmlFor="admin-jwt">
              输入 Bearer JWT
            </label>
            <textarea
              id="admin-jwt"
              className="input textarea"
              disabled={pending}
              onChange={(event) => setJwtToken(event.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              value={jwtToken}
            />
            <div className="toolbar">
              <button className="action" disabled={pending || jwtToken.trim().length === 0} type="submit">
                {pending ? '校验中...' : '应用 JWT'}
              </button>
              <button className="action action-secondary" disabled={pending} onClick={() => void onClearJwt()} type="button">
                清除 JWT
              </button>
            </div>
          </form>
          {session?.authenticated ? <p>当前已通过 JWT 认证：admin</p> : <p className="meta-text">当前未通过 JWT 认证。</p>}
          {actionError ? <p className="error-text">{actionError}</p> : null}
        </div>
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
  adminState: AdminState | null;
  latestCreatedToken: ApiTokenCreateResult | null;
  models: ModelListData | null;
  modelsError: string | null;
  pending: boolean;
  playgroundResult: ChatCompletionResponse | CompletionCreateResult | ResponseCreateResult | EmbeddingsCreateResult | ModerationsCreateResult | null;
  chatError: string | null;
  onReloadModels: () => Promise<void>;
  onSend: (input: {
    mode: 'chat' | 'responses' | 'completions' | 'embeddings' | 'moderations';
    model: string;
    prompt: string;
    systemPrompt: string;
    bearerToken?: string;
  }) => Promise<void>;
}) {
  const {
    status,
    adminState,
    latestCreatedToken,
    models,
    modelsError,
    pending,
    playgroundResult,
    chatError,
    onReloadModels,
    onSend
  } = props;
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('用一句话说明你是一个 Cloudflare 上运行的最小 AI 网关。');
  const [systemPrompt, setSystemPrompt] = useState('你是一个简洁的系统说明助手。');
  const [mode, setMode] = useState<'chat' | 'responses' | 'completions' | 'embeddings' | 'moderations'>('responses');
  const [useApiToken, setUseApiToken] = useState(false);
  const [relayToken, setRelayToken] = useState('');

  const usesSystemPrompt = mode === 'chat' || mode === 'responses';
  const endpointLabel =
    mode === 'responses'
      ? '/v1/responses'
      : mode === 'chat'
        ? '/v1/chat/completions'
        : mode === 'completions'
          ? '/v1/completions'
        : mode === 'embeddings'
          ? '/v1/embeddings'
          : '/v1/moderations';

  useEffect(() => {
    if (!model && models && models.data.length > 0) {
      setModel(models.data[0].id);
    }
  }, [model, models]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSend({
      mode,
      model,
      prompt,
      systemPrompt,
      bearerToken: useApiToken ? relayToken : undefined
    });
  }

  if (!status) {
    return null;
  }

  const playgroundEnabled = adminState?.settings.playgroundEnabled ?? true;

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
        <div className="segmented">
          <button
            className={`chip ${mode === 'responses' ? 'chip-active' : ''}`}
            disabled={pending}
            onClick={() => setMode('responses')}
            type="button"
          >
            /v1/responses
          </button>
          <button
            className={`chip ${mode === 'chat' ? 'chip-active' : ''}`}
            disabled={pending}
            onClick={() => setMode('chat')}
            type="button"
          >
            /v1/chat/completions
          </button>
          <button
            className={`chip ${mode === 'completions' ? 'chip-active' : ''}`}
            disabled={pending}
            onClick={() => setMode('completions')}
            type="button"
          >
            /v1/completions
          </button>
          <button
            className={`chip ${mode === 'embeddings' ? 'chip-active' : ''}`}
            disabled={pending}
            onClick={() => setMode('embeddings')}
            type="button"
          >
            /v1/embeddings
          </button>
          <button
            className={`chip ${mode === 'moderations' ? 'chip-active' : ''}`}
            disabled={pending}
            onClick={() => setMode('moderations')}
            type="button"
          >
            /v1/moderations
          </button>
        </div>
        {modelsError ? <p className="error-text">{modelsError}</p> : null}
        {!playgroundEnabled ? <p className="error-text">当前 D1 设置已关闭 playground。</p> : null}
        {latestCreatedToken ? (
          <p className="meta-text">最近创建 token: {latestCreatedToken.descriptor.name} / ****{latestCreatedToken.descriptor.last4}</p>
        ) : null}
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
          {usesSystemPrompt ? (
            <>
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
            </>
          ) : null}
          <label className="label" htmlFor="user-prompt">
            {mode === 'embeddings' ? 'Embedding Input' : mode === 'moderations' ? 'Moderation Input' : mode === 'completions' ? 'Completion Prompt' : 'User Prompt'}
          </label>
          <textarea
            id="user-prompt"
            className="input textarea"
            disabled={pending}
            onChange={(event) => setPrompt(event.target.value)}
            value={prompt}
          />
          <label className="checkbox-row">
            <input
              checked={useApiToken}
              disabled={pending}
              onChange={(event) => setUseApiToken(event.target.checked)}
              type="checkbox"
            />
            <span>使用 API token 调用 <code>{endpointLabel}</code></span>
          </label>
          {useApiToken ? (
            <>
              <label className="label" htmlFor="relay-token">
                Relay Token
              </label>
              <textarea
                id="relay-token"
                className="input textarea textarea-compact"
                disabled={pending}
                onChange={(event) => setRelayToken(event.target.value)}
                placeholder="粘贴新创建的 API token"
                value={relayToken}
              />
            </>
          ) : null}
          <button className="action" disabled={pending || !playgroundEnabled || !model || prompt.trim().length === 0} type="submit">
            {pending ? '请求中...' : `发送到 ${endpointLabel}`}
          </button>
        </form>
        {chatError ? <p className="error-text">{chatError}</p> : null}
        <pre className="status-block status-block-soft">
          {JSON.stringify(playgroundResult ?? { message: '尚未发送请求' }, null, 2)}
        </pre>
      </div>
    </section>
  );
}

function TokenPanel(props: {
  session: SessionData | null;
  tokens: ApiTokenDescriptor[];
  latestCreatedToken: ApiTokenCreateResult | null;
  pending: boolean;
  tokenError: string | null;
  onCreate: (name: string) => Promise<void>;
  onUpdate: (tokenId: string, input: { name: string; enabled: boolean }) => Promise<void>;
  onDelete: (tokenId: string) => Promise<void>;
}) {
  const { session, tokens, latestCreatedToken, pending, tokenError, onCreate, onUpdate, onDelete } = props;
  const [name, setName] = useState('default relay token');

  if (!session?.authenticated) {
    return null;
  }

  return (
    <section className="panel panel-soft">
      <div className="panel-header">
        <h2>API Tokens</h2>
        <span className="badge">{tokens.length} tokens</span>
      </div>
      <div className="stack">
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate(name);
          }}
        >
          <input
            className="input"
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <button className="action" disabled={pending || name.trim().length === 0} type="submit">
            创建 token
          </button>
        </form>
        {latestCreatedToken ? (
          <pre className="status-block status-block-soft">
            {JSON.stringify(latestCreatedToken, null, 2)}
          </pre>
        ) : null}
        {tokenError ? <p className="error-text">{tokenError}</p> : null}
        {tokens.length === 0 ? (
          <p className="meta-text">当前没有 API token。</p>
        ) : (
          tokens.map((token) => (
            <TokenRowEditor
              key={token.id}
              disabled={pending}
              onDelete={onDelete}
              onSave={onUpdate}
              token={token}
            />
          ))
        )}
      </div>
    </section>
  );
}

function TokenRowEditor(props: {
  token: ApiTokenDescriptor;
  disabled: boolean;
  onSave: (tokenId: string, input: { name: string; enabled: boolean }) => Promise<void>;
  onDelete: (tokenId: string) => Promise<void>;
}) {
  const { token, disabled, onSave, onDelete } = props;
  const [name, setName] = useState(token.name);
  const [enabled, setEnabled] = useState(token.enabled);

  useEffect(() => {
    setName(token.name);
    setEnabled(token.enabled);
  }, [token.enabled, token.name]);

  return (
    <form
      className="model-row"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(token.id, {
          name,
          enabled
        });
      }}
    >
      <div className="model-row-main">
        <strong>{token.name}</strong>
        <span className="meta-text">id {token.id} / ****{token.last4}</span>
        <input
          className="input"
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </div>
      <label className="checkbox-row">
        <input
          checked={enabled}
          disabled={disabled}
          onChange={(event) => setEnabled(event.target.checked)}
          type="checkbox"
        />
        <span>启用</span>
      </label>
      <div className="token-actions">
        <button className="action action-secondary" disabled={disabled} type="submit">
          保存
        </button>
        <button
          className="action action-danger"
          disabled={disabled}
          onClick={() => void onDelete(token.id)}
          type="button"
        >
          删除
        </button>
      </div>
    </form>
  );
}

function ControlPlanePanel(props: {
  status: StatusData | null;
  session: SessionData | null;
  adminState: AdminState | null;
  adminError: string | null;
  pending: boolean;
  onBootstrap: () => Promise<void>;
  onSaveSettings: (settings: AdminState['settings']) => Promise<void>;
  onUpdateModel: (modelId: string, input: { label: string; enabled: boolean; upstreamProfileId: string }) => Promise<void>;
}) {
  const { status, session, adminState, adminError, pending, onBootstrap, onSaveSettings, onUpdateModel } = props;
  const [publicAppName, setPublicAppName] = useState('');
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [playgroundEnabled, setPlaygroundEnabled] = useState(true);

  useEffect(() => {
    if (adminState) {
      setPublicAppName(adminState.settings.publicAppName);
      setWelcomeMessage(adminState.settings.welcomeMessage);
      setPlaygroundEnabled(adminState.settings.playgroundEnabled);
    }
  }, [adminState]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSaveSettings({
      publicAppName,
      welcomeMessage,
      playgroundEnabled
    });
  }

  if (!status) {
    return null;
  }

  return (
    <section className="panel panel-soft">
      <div className="panel-header">
        <h2>D1 Control Plane</h2>
        <span className={`badge ${status.d1Configured ? '' : 'badge-error'}`}>
          {status.d1Configured ? `${status.stateStore} mode` : 'd1 missing'}
        </span>
      </div>
      <div className="stack">
        <p className="meta-text">D1 负责低频控制数据：系统设置与模型目录。secrets 仍保留在 Worker 环境变量。</p>
        {!status.d1Configured ? <p className="error-text">当前 Worker 未绑定 D1，本地或远端需先配置数据库。</p> : null}
        {session?.authenticated && status.d1Configured && adminState?.models.length === 0 ? (
          <button className="action" disabled={pending} onClick={() => void onBootstrap()} type="button">
            从环境变量 bootstrap 模型目录
          </button>
        ) : null}
        {adminError ? <p className="error-text">{adminError}</p> : null}
        {session?.authenticated && adminState ? (
          <>
            <form className="stack" onSubmit={(event) => void handleSave(event)}>
              <label className="label" htmlFor="public-app-name">
                Public App Name
              </label>
              <input
                id="public-app-name"
                className="input"
                disabled={pending}
                onChange={(event) => setPublicAppName(event.target.value)}
                value={publicAppName}
              />
              <label className="label" htmlFor="welcome-message">
                Welcome Message
              </label>
              <textarea
                id="welcome-message"
                className="input textarea"
                disabled={pending}
                onChange={(event) => setWelcomeMessage(event.target.value)}
                value={welcomeMessage}
              />
              <label className="checkbox-row">
                <input
                  checked={playgroundEnabled}
                  disabled={pending}
                  onChange={(event) => setPlaygroundEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span>启用 playground</span>
              </label>
              <button className="action" disabled={pending} type="submit">
                保存设置
              </button>
            </form>

            <div className="stack">
              <h3 className="section-title">模型目录</h3>
              <div className="profile-list">
                {adminState.profiles.map((profile) => (
                  <article className="profile-card" key={profile.id}>
                    <strong>{profile.label}</strong>
                    <span className="meta-text">
                      {profile.id} / {profile.providerName}
                      {profile.isDefault ? ' / default' : ''}
                    </span>
                    <span className="meta-text">{profile.supportedModelIds.join(', ') || 'no models declared'}</span>
                    <span className="meta-text">
                      assigned: {profile.assignedModelIds.join(', ') || 'none'}
                    </span>
                    <span className="meta-text">
                      enabled: {profile.enabledAssignedModelIds.join(', ') || 'none'}
                    </span>
                  </article>
                ))}
              </div>
              {adminState.models.length === 0 ? (
                <p className="meta-text">当前 D1 模型目录为空。</p>
              ) : (
                adminState.models.map((model) => (
                  <ModelRowEditor
                    key={model.id}
                    disabled={pending}
                    model={model}
                    profiles={adminState.profiles}
                    onSave={onUpdateModel}
                  />
                ))
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function ModelRowEditor(props: {
  model: AdminState['models'][number];
  disabled: boolean;
  profiles: AdminState['profiles'];
  onSave: (modelId: string, input: { label: string; enabled: boolean; upstreamProfileId: string }) => Promise<void>;
}) {
  const { model, disabled, profiles, onSave } = props;
  const compatibleProfiles = profiles.filter((profile) => profile.supportedModelIds.includes(model.id));
  const hasProfileDrift = model.upstreamProfileExists === false || model.upstreamProfileSupportsModel === false;
  const [label, setLabel] = useState(model.label ?? model.id);
  const [enabled, setEnabled] = useState(model.enabled ?? true);
  const [upstreamProfileId, setUpstreamProfileId] = useState(model.upstreamProfileId ?? compatibleProfiles[0]?.id ?? '');

  useEffect(() => {
    setLabel(model.label ?? model.id);
  }, [model.id, model.label]);

  useEffect(() => {
    setEnabled(model.enabled ?? true);
  }, [model.enabled, model.id]);

  useEffect(() => {
    setUpstreamProfileId(model.upstreamProfileId ?? compatibleProfiles[0]?.id ?? '');
  }, [compatibleProfiles, model.upstreamProfileId]);

  return (
    <form
      className="model-row"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(model.id, {
          label,
          enabled,
          upstreamProfileId
        });
      }}
    >
      <div className="model-row-main">
        <strong>{model.id}</strong>
        <input
          className="input"
          disabled={disabled}
          onChange={(event) => setLabel(event.target.value)}
          value={label}
        />
        <select
          className="input"
          disabled={disabled || compatibleProfiles.length === 0}
          onChange={(event) => setUpstreamProfileId(event.target.value)}
          value={upstreamProfileId}
        >
          {compatibleProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label} / {profile.providerName}
            </option>
          ))}
        </select>
        {compatibleProfiles.length === 0 ? <span className="error-text">当前没有声明支持该模型的 upstream profile。</span> : null}
        {hasProfileDrift ? (
          <span className="error-text">
            当前绑定的 upstream profile 已失效或不再声明支持该模型，保存后可修复。
          </span>
        ) : null}
      </div>
      <label className="checkbox-row">
        <input
          checked={enabled}
          disabled={disabled}
          onChange={(event) => setEnabled(event.target.checked)}
          type="checkbox"
        />
        <span>启用</span>
      </label>
      <button className="action action-secondary" disabled={disabled || compatibleProfiles.length === 0} type="submit">
        保存模型
      </button>
    </form>
  );
}

function UsagePanel(props: {
  session: SessionData | null;
  usage: UsageOverview | null;
  usageWindowDays: number;
  usageError: string | null;
  pending: boolean;
  onReload: (days: number) => Promise<void>;
}) {
  const { session, usage, usageWindowDays, usageError, pending, onReload } = props;

  if (!session?.authenticated) {
    return null;
  }

  const rows = usage?.rows ?? [];

  return (
    <section className="panel panel-soft">
      <div className="panel-header">
        <h2>Usage Overview</h2>
        <span className="badge">{usage?.totals.requestCount ?? 0} requests</span>
      </div>
      <div className="stack">
        <div className="toolbar toolbar-wrap">
          <div className="segmented">
            {[7, 30].map((days) => (
              <button
                key={days}
                className={`chip ${usageWindowDays === days ? 'chip-active' : ''}`}
                disabled={pending}
                onClick={() => void onReload(days)}
                type="button"
              >
                近 {days} 天
              </button>
            ))}
          </div>
          <span className="meta-text">只保留 D1 日聚合，不写逐请求明细。</span>
        </div>
        {usageError ? <p className="error-text">{usageError}</p> : null}
        {usage ? (
          <div className="usage-summary-grid">
            <article className="usage-summary-card">
              <strong>{usage.totals.successCount}</strong>
              <span>成功请求</span>
            </article>
            <article className="usage-summary-card">
              <strong>{usage.totals.errorCount}</strong>
              <span>失败请求</span>
            </article>
            <article className="usage-summary-card">
              <strong>{usage.totals.activeActorCount}</strong>
              <span>活跃调用方</span>
            </article>
            <article className="usage-summary-card">
              <strong>{usage.totals.activeModelCount}</strong>
              <span>活跃模型</span>
            </article>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <p className="meta-text">当前窗口内还没有 relay usage 聚合数据。</p>
        ) : (
          <div className="usage-table">
            <div className="usage-table-head">
              <span>日期</span>
              <span>调用方</span>
              <span>Profile</span>
              <span>模型</span>
              <span>请求</span>
              <span>成功</span>
              <span>失败</span>
              <span>状态</span>
            </div>
            {rows.slice(0, 24).map((row) => (
              <div key={`${row.usageDate}:${row.actorKind}:${row.actorId}:${row.model}`} className="usage-table-row">
                <span>{row.usageDate}</span>
                <span>
                  {row.actorLabel}
                  {row.actorLast4 ? ` / ****${row.actorLast4}` : ''}
                </span>
                <span>{row.upstreamProfileLabel}</span>
                <span>{row.model}</span>
                <span>{row.requestCount}</span>
                <span>{row.successCount}</span>
                <span>{row.errorCount}</span>
                <span>{row.lastStatus}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function App() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);
  const [models, setModels] = useState<ModelListData | null>(null);
  const [adminState, setAdminState] = useState<AdminState | null>(null);
  const [adminTokens, setAdminTokens] = useState<ApiTokenDescriptor[]>([]);
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [usageWindowDays, setUsageWindowDays] = useState(7);
  const [latestCreatedToken, setLatestCreatedToken] = useState<ApiTokenCreateResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatResult, setChatResult] = useState<ChatCompletionResponse | CompletionCreateResult | ResponseCreateResult | EmbeddingsCreateResult | ModerationsCreateResult | null>(null);
  const [pending, setPending] = useState(false);
  const [storedAdminJwt, setStoredAdminJwt] = useState('');

  async function refreshAdminState(nextSession?: SessionData | null) {
    const currentSession = nextSession ?? session;
    if (!currentSession?.authenticated) {
      setAdminState(null);
      setAdminTokens([]);
      return;
    }

    setAdminError(null);
    try {
      const nextAdminState = await fetchAdminState();
      setAdminState(nextAdminState);
      setModels({
        object: 'list',
        stateStore: nextAdminState.stateStore,
        data: nextAdminState.models
      });
    } catch (cause) {
      setAdminState(null);
      setAdminError(cause instanceof Error ? cause.message : 'failed to load admin state');
    }
  }

  async function refreshAdminTokens(nextSession?: SessionData | null) {
    const currentSession = nextSession ?? session;
    if (!currentSession?.authenticated) {
      setAdminTokens([]);
      return;
    }

    setTokenError(null);
    try {
      const payload = await fetchAdminTokens();
      setAdminTokens(payload.data);
    } catch (cause) {
      setAdminTokens([]);
      setTokenError(cause instanceof Error ? cause.message : 'failed to load admin tokens');
    }
  }

  async function refreshAdminUsage(nextSession?: SessionData | null, windowDays = usageWindowDays) {
    const currentSession = nextSession ?? session;
    if (!currentSession?.authenticated) {
      setUsage(null);
      setUsageError(null);
      return;
    }

    setUsageError(null);
    try {
      const nextUsage = await fetchAdminUsage(windowDays);
      setUsage(nextUsage);
      setUsageWindowDays(windowDays);
    } catch (cause) {
      setUsage(null);
      setUsageError(cause instanceof Error ? cause.message : 'failed to load usage overview');
    }
  }

  async function refresh() {
    const [nextStatus, nextSession] = await Promise.all([fetchStatus(), fetchSession()]);
    setStatus(nextStatus);
    setSession(nextSession);
    await refreshAdminState(nextSession);
    await refreshAdminTokens(nextSession);
    await refreshAdminUsage(nextSession);
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

  async function handleBootstrapControlPlane() {
    setPending(true);
    setAdminError(null);
    try {
      const nextState = await bootstrapAdminState();
      setAdminState(nextState);
      setModels({
        object: 'list',
        stateStore: nextState.stateStore,
        data: nextState.models
      });
      await refresh();
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : 'bootstrap failed');
    } finally {
      setPending(false);
    }
  }

  async function handleSaveSettings(input: AdminState['settings']) {
    setPending(true);
    setAdminError(null);
    try {
      await saveAdminSettings(input);
      await refreshAdminState();
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : 'save settings failed');
    } finally {
      setPending(false);
    }
  }

  async function handleUpdateModel(modelId: string, input: { label: string; enabled: boolean; upstreamProfileId: string }) {
    setPending(true);
    setAdminError(null);
    try {
      await updateAdminModel(modelId, input);
      await refreshAdminState();
      await loadModels();
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : 'update model failed');
    } finally {
      setPending(false);
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
      clearStoredAdminJwt();
      setStoredAdminJwt('');
      setChatResult(null);
      setLatestCreatedToken(null);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'logout failed');
    } finally {
      setPending(false);
    }
  }

  async function handleSend(input: {
    mode: 'chat' | 'responses' | 'completions' | 'embeddings' | 'moderations';
    model: string;
    prompt: string;
    systemPrompt: string;
    bearerToken?: string;
  }) {
    setPending(true);
    setChatError(null);
    try {
      const result = input.mode === 'responses'
        ? await sendResponseCreate(input)
        : input.mode === 'completions'
          ? await sendCompletionCreate(input)
        : input.mode === 'embeddings'
          ? await sendEmbeddingsCreate(input)
          : input.mode === 'moderations'
            ? await sendModerationsCreate(input)
            : await sendChatCompletion(input);
      setChatResult(result);
      await refreshAdminUsage();
    } catch (cause) {
      setChatResult(null);
      setChatError(cause instanceof Error ? cause.message : 'chat request failed');
      await refreshAdminUsage();
    } finally {
      setPending(false);
    }
  }

  async function handleCreateToken(name: string) {
    setPending(true);
    setTokenError(null);
    try {
      const result = await createAdminToken(name);
      setLatestCreatedToken(result);
      await refreshAdminTokens();
    } catch (cause) {
      setTokenError(cause instanceof Error ? cause.message : 'create token failed');
    } finally {
      setPending(false);
    }
  }

  async function handleUpdateToken(tokenId: string, input: { name: string; enabled: boolean }) {
    setPending(true);
    setTokenError(null);
    try {
      await updateAdminToken(tokenId, input);
      await refreshAdminTokens();
      await refreshAdminUsage();
    } catch (cause) {
      setTokenError(cause instanceof Error ? cause.message : 'update token failed');
    } finally {
      setPending(false);
    }
  }

  async function handleDeleteToken(tokenId: string) {
    setPending(true);
    setTokenError(null);
    try {
      await deleteAdminToken(tokenId);
      await refreshAdminTokens();
      await refreshAdminUsage();
    } catch (cause) {
      setTokenError(cause instanceof Error ? cause.message : 'delete token failed');
    } finally {
      setPending(false);
    }
  }

  async function handleApplyJwt(token: string) {
    setPending(true);
    setActionError(null);
    try {
      storeAdminJwt(token);
      setStoredAdminJwt(getStoredAdminJwt() ?? '');
      const nextSession = await fetchSession();
      setSession(nextSession);
      if (!nextSession.authenticated) {
        throw new Error('jwt 无效或未通过 admin 校验');
      }
      await refresh();
    } catch (cause) {
      clearStoredAdminJwt();
      setStoredAdminJwt('');
      setSession({
        authenticated: false,
        authMode: 'jwt'
      });
      setActionError(cause instanceof Error ? cause.message : 'jwt apply failed');
    } finally {
      setPending(false);
    }
  }

  async function handleClearJwt() {
    setPending(true);
    setActionError(null);
    try {
      clearStoredAdminJwt();
      setStoredAdminJwt('');
      setSession({
        authenticated: false,
        authMode: 'jwt'
      });
      setAdminState(null);
      setAdminTokens([]);
      setUsage(null);
      setChatResult(null);
      const [nextStatus, nextSession] = await Promise.all([fetchStatus(), fetchSession()]);
      setStatus(nextStatus);
      setSession(nextSession);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'jwt clear failed');
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!cancelled) {
          setStoredAdminJwt(getStoredAdminJwt() ?? '');
        }
        const [nextStatus, nextSession] = await Promise.all([fetchStatus(), fetchSession()]);
        if (cancelled) {
          return;
        }

        setStatus(nextStatus);
        setSession(nextSession);
        if (nextSession.authenticated) {
          if (!cancelled) {
            await Promise.all([
              refreshAdminState(nextSession),
              refreshAdminTokens(nextSession),
              refreshAdminUsage(nextSession, usageWindowDays)
            ]);
          }
        } else {
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
          initialJwtToken={storedAdminJwt}
          onLogin={handleLogin}
          onLogout={handleLogout}
          onApplyJwt={handleApplyJwt}
          onClearJwt={handleClearJwt}
          pending={pending}
          session={session}
          status={status}
        />
        <ControlPlanePanel
          adminError={adminError}
          adminState={adminState}
          onBootstrap={handleBootstrapControlPlane}
          onSaveSettings={handleSaveSettings}
          onUpdateModel={handleUpdateModel}
          pending={pending}
          session={session}
          status={status}
        />
      </div>

      <div className="grid grid-two">
        <PlaygroundPanel
          adminState={adminState}
          chatError={chatError}
          playgroundResult={chatResult}
          latestCreatedToken={latestCreatedToken}
          models={models}
          modelsError={modelsError}
          onReloadModels={loadModels}
          onSend={handleSend}
          pending={pending}
          status={status}
        />
        <TokenPanel
          latestCreatedToken={latestCreatedToken}
          onCreate={handleCreateToken}
          onDelete={handleDeleteToken}
          onUpdate={handleUpdateToken}
          pending={pending}
          session={session}
          tokenError={tokenError}
          tokens={adminTokens}
        />
      </div>

      <UsagePanel
        onReload={(days) => refreshAdminUsage(undefined, days)}
        pending={pending}
        session={session}
        usage={usage}
        usageError={usageError}
        usageWindowDays={usageWindowDays}
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
