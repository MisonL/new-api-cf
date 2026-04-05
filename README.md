# new-api-cf

`new-api` 面向 Cloudflare 资源体系的重构版探索仓库。

当前目标不是机械迁移现有 Go/Gin 服务，而是基于 Cloudflare 的运行模型重新设计一个新项目：

- 控制面：Workers / Cron / Durable Objects / Queues
- 数据面：Edge API / 流式转发 / 静态前端
- 状态面：D1 / KV / R2 / 外部数据库与缓存的兼容桥接

本目录当前包含两类内容：

- 详尽调研：Cloudflare Free 计划约束、可行边界、不可行边界、资源分层映射
- 最小工程骨架：用于承载后续 `new-api` Cloudflare 化重构

## 已搭建骨架

当前仓库已经包含以下可执行模块：

- `apps/edge-api`
  - `GET /`
  - `GET /api/status`
  - `GET /api/auth/session`
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/admin/state`
  - `POST /api/admin/bootstrap`
  - `PUT /api/admin/settings`
  - `PATCH /api/admin/models/:id`
  - `GET /api/admin/tokens`
  - `GET /api/admin/usage`
  - `POST /api/admin/tokens`
  - `PATCH /api/admin/tokens/:id`
  - `DELETE /api/admin/tokens/:id`
  - `GET /api/me`
  - `GET /api/models`
  - `GET /v1/files`
  - `POST /v1/files`
  - `GET /v1/files/:fileId`
  - `GET /v1/files/:fileId/content`
  - `DELETE /v1/files/:fileId`
  - `GET /v1/models`
  - `POST /v1/audio/speech`
  - `POST /v1/audio/transcriptions`
  - `POST /v1/audio/translations`
  - `POST /v1/chat/completions`
  - `POST /v1/completions`
  - `POST /v1/embeddings`
  - `POST /v1/images/edits`
  - `POST /v1/images/generations`
  - `POST /v1/images/variations`
  - `POST /v1/moderations`
  - `POST /v1/responses`
- `apps/admin-web`
  - React + Vite 前端骨架
  - 登录面板
  - D1 控制面设置
  - 模型目录编辑
  - API token 管理
  - usage 聚合概览
  - 最小 relay playground
- `packages/shared`
  - 共享 DTO、错误模型和最小 relay 契约

说明：

- 当前 relay 只支持 OpenAI-compatible 上游
- 当前已支持“多 upstream profile 定义在 Worker env，模型到 profile 映射落在 D1”
- 若未配置上游环境变量，`/api/models`、`/v1/files`、`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/audio/translations`、`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/images/edits`、`/v1/images/generations`、`/v1/images/variations`、`/v1/moderations` 和 `/v1/responses` 会显式失败
- 若使用 `AUTH_MODE=session`，可通过 admin token 登录换取 HMAC 签名 cookie
- 若前端与 Worker 分域部署，需显式配置 `CORS_ORIGIN`
- Worker 会为每个请求生成 `x-request-id`
- relay 会透传上游 `x-request-id` 到 `x-upstream-request-id`
- relay 支持 `UPSTREAM_TIMEOUT_MS`，默认 `30000`
- D1 负责低频控制数据：
  - `control_settings`
  - `relay_models`
  - `api_tokens`
  - `usage_daily`
- 若绑定 `MODEL_CATALOG_CACHE`，Worker 会把“启用中的模型目录快照”写入 KV：
  - 只在 bootstrap / 模型更新时刷新
  - 读取命中时优先走 KV，降低 `/api/models` 和 relay 前置校验的 D1 读取
  - 不承载配额、计数器或其他强一致状态
- 若绑定 `USAGE_EVENTS` Queue，relay usage 会优先异步入队：
  - Queue consumer 在同一个 Worker 内批量聚合写回 D1
  - 未绑定 Queue 时，继续走当前同步 D1 兜底
  - 这样可以把 usage 聚合逐步从主链移出，而不改变当前接口行为
- 若绑定 `RELAY_LIMITER` Durable Object 且配置 `RELAY_RATE_LIMIT_PER_MINUTE`：
  - `/v1/files`、`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/audio/translations`、`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/images/edits`、`/v1/images/generations`、`/v1/images/variations`、`/v1/moderations` 与 `/v1/responses` 会按调用方执行每分钟速率门禁
  - 当前调用方粒度为 `admin-session` 或 `api-token`
  - 配置了速率上限但未绑定 DO 时会显式失败，不做静默绕过
- `/api/admin/usage` 提供近 1 到 30 天的 D1 usage 日聚合视图：
  - 按 `usage_date + actor + upstream profile + model` 聚合
  - 当前只记录请求数、成功数、失败数和最近状态码
  - 不写逐请求明细，优先控制 Free 额度写放大
- 当 Worker 已绑定 D1 且目录为空时，`/api/models` 会显式返回 `MODEL_CATALOG_EMPTY`
- `/v1/files`、`/v1/models`、`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/audio/translations`、`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/images/edits`、`/v1/images/generations`、`/v1/images/variations`、`/v1/moderations` 与 `/v1/responses` 当前要求：
  - admin session
  - 或 D1 API token
- `files` 相关接口当前固定走默认 upstream profile，不参与模型目录校验
- 当前已接入 D1，KV / Durable Objects / Queues 仍未接入

## 开发命令

```bash
bun install
bun run types:edge
bun run check
bun run --cwd apps/edge-api d1:migrate:local
```

环境变量：

- `AUTH_MODE=disabled|bearer|session|jwt`
- `ADMIN_BEARER_TOKEN=<token>`
- `ADMIN_JWT_SECRET=<32+ chars secret>`
- `ADMIN_JWT_ISSUER=<optional issuer>`
- `ADMIN_JWT_AUDIENCE=<optional audience>`
- `SESSION_SECRET=<32+ chars secret>`
- `CORS_ORIGIN=http://127.0.0.1:4173,https://admin.example.com`
- `UPSTREAM_TIMEOUT_MS=30000`
- `OPENAI_BASE_URL=<https://.../v1>`
- `OPENAI_API_KEY=<key>`
- `OPENAI_MODEL_ALLOWLIST=gpt-4o-mini,gpt-4.1-mini`
- `OPENAI_PROVIDER_NAME=<provider-name>`
- `UPSTREAM_PROFILES_JSON=[{"id":"primary","label":"Primary","baseUrl":"https://.../v1","apiKey":"...","providerName":"provider-a","modelAllowlist":["gpt-4o-mini"]}]`
- `UPSTREAM_DEFAULT_PROFILE_ID=primary`
- `MODEL_CATALOG_CACHE=<optional KV binding>`
- `USAGE_EVENTS=<optional Queue binding>`
- `RELAY_LIMITER=<optional Durable Object binding>`
- `RELAY_RATE_LIMIT_PER_MINUTE=60`
- `VITE_EDGE_API_BASE_URL=https://edge.example.com`

说明：

- 推荐使用 `UPSTREAM_PROFILES_JSON` + `UPSTREAM_DEFAULT_PROFILE_ID` 定义多个 upstream profile
- `relay_models.upstream_profile_id` 负责把模型绑定到某个 profile
- 旧的 `OPENAI_*` 单 profile 环境变量仍可继续作为兼容入口
- `AUTH_MODE=jwt` 下，管理接口通过 Bearer JWT 校验：
  - 当前要求 `HS256`
  - payload 至少满足 `role=admin` 或 `sub=admin`
  - 同时校验 `exp`
  - 若配置了 `ADMIN_JWT_ISSUER` 或 `ADMIN_JWT_AUDIENCE`，也会一并校验
- 当前 playground 支持切换调用：
  - `/v1/responses`
  - `/v1/audio/speech`
  - `/v1/audio/transcriptions`
  - `/v1/audio/translations`
  - `/v1/chat/completions`
  - `/v1/completions`
  - `/v1/embeddings`
  - `/v1/images/edits`
  - `/v1/images/generations`
  - `/v1/images/variations`
  - `/v1/moderations`

本地 D1 初始化流程：

1. `bun run --cwd apps/edge-api d1:migrate:local`
2. 启动 Worker
3. 登录管理页
4. 调用 `/api/admin/bootstrap` 初始化 D1 控制面目录
5. 通过 `/api/admin/tokens` 创建用户侧 relay token

## 目录结构

```text
new-api-cf/
  apps/
    edge-api/      Cloudflare Workers 边缘 API 原型
    admin-web/     Cloudflare Pages 管理前端占位
  docs/
    cloudflare-free-feasibility.md
    target-architecture.md
  packages/
    shared/        共享类型与契约占位
```

## 当前判断

基于原项目代码事实和 Cloudflare 官方能力边界，当前结论是：

- 原版 `new-api` 不适合直接“原样迁移”为 Cloudflare Free 原生全栈
- `new-api-cf` 应定义为 Worker-first 的重构项目，而不是原版后端的直接翻译
- Cloudflare Free 适合承载一个 10 人以内并发的小规模版本，只要控制写放大、后台任务密度和热点状态规模
- 推荐充分使用的 Free 资源：
  - Pages
  - Workers
  - D1
  - Durable Objects
  - KV
  - R2
  - Queues

详见：

- [cloudflare-free-feasibility.md](/Volumes/Work/code/new-api-cf/docs/cloudflare-free-feasibility.md)
- [target-architecture.md](/Volumes/Work/code/new-api-cf/docs/target-architecture.md)
- [free-tier-10-users-blueprint.md](/Volumes/Work/code/new-api-cf/docs/free-tier-10-users-blueprint.md)
