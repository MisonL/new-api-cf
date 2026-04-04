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
  - `GET /api/me`
  - `GET /api/models`
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- `apps/admin-web`
  - React + Vite 前端骨架
  - 登录面板
  - 模型列表读取
  - 最小 chat playground
- `packages/shared`
  - 共享 DTO、错误模型和最小 relay 契约

说明：

- 当前 relay 只支持 OpenAI-compatible 上游
- 若未配置上游环境变量，`/api/models` 和 `/v1/chat/completions` 会显式失败
- 若使用 `AUTH_MODE=session`，可通过 admin token 登录换取 HMAC 签名 cookie
- 若前端与 Worker 分域部署，需显式配置 `CORS_ORIGIN`
- Worker 会为每个请求生成 `x-request-id`
- relay 会透传上游 `x-request-id` 到 `x-upstream-request-id`
- relay 支持 `UPSTREAM_TIMEOUT_MS`，默认 `30000`
- 当前未引入 D1 / KV / Durable Objects / Queues 绑定，仍处于 Phase 1 骨架态

## 开发命令

```bash
bun install
bun run types:edge
bun run check
```

环境变量：

- `AUTH_MODE=disabled|bearer|session`
- `ADMIN_BEARER_TOKEN=<token>`
- `SESSION_SECRET=<32+ chars secret>`
- `CORS_ORIGIN=http://127.0.0.1:4173,https://admin.example.com`
- `UPSTREAM_TIMEOUT_MS=30000`
- `OPENAI_BASE_URL=<https://.../v1>`
- `OPENAI_API_KEY=<key>`
- `OPENAI_MODEL_ALLOWLIST=gpt-4o-mini,gpt-4.1-mini`
- `OPENAI_PROVIDER_NAME=<provider-name>`
- `VITE_EDGE_API_BASE_URL=https://edge.example.com`

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
