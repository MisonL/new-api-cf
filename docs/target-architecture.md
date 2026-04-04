# new-api-cf 顶层架构设计

## 1. 设计原则

### 1.1 原则

- 不原样搬运 Go/Gin 运行时
- 不把 Cloudflare 只当 CDN，而是当资源分层平台
- Free 计划优先，设计时先满足最严格约束
- 先保留最核心业务闭环，再补管理与运营能力

### 1.2 不变量

- 统一 API 网关定位不变
- 管理前端仍是独立界面
- 认证必须保持可扩展
- 核心 relay 能力必须保持可流式
- 状态写入路径必须可审计

## 2. 顶层资源分层

```text
Browser
  -> Cloudflare Pages
  -> Cloudflare Worker API Gateway
     -> Durable Objects (hot state / serialized counters)
     -> D1 (metadata / low-write control plane data)
     -> KV (cache / flags / read-mostly snapshots)
     -> R2 (archives / exports / large payloads)
     -> Optional External Core Services
        -> PostgreSQL
        -> Redis
        -> Legacy bridge services
```

## 3. 控制面 / 数据面 / 状态面

### 3.1 控制面

由以下资源承担：

- Worker 路由分发
- Cron 触发的轻量任务
- Durable Objects 内部串行控制
- Queue 消费者

控制面只负责：

- 路由
- 限流决策
- 幂等判定
- 基础调度
- 热点状态协调

### 3.2 数据面

由以下资源承担：

- Worker API
- 流式 relay handler
- Pages 前端

数据面只保留最短主路径：

- 鉴权
- 请求规范化
- 上游转发
- 结果回写

### 3.3 状态面

按状态类型拆分：

- D1：低频写入、强结构化元数据
- Durable Objects：热点、串行、一致性要求高的小状态
- KV：读多写少、允许短暂延迟的缓存
- R2：大对象
- 外部 DB：超出 Free 计划边界的核心数据

## 4. 模块拆分建议

## 4.1 apps/admin-web

职责：

- 管理界面
- 用户中心
- 渠道配置页
- OAuth 发起页与回调页

运行位置：

- Cloudflare Pages

## 4.2 apps/edge-api

职责：

- `/api/status`
- `/api/auth/*`
- `/api/token/*`
- `/api/channel/*`
- `/v1/chat/completions` 等最小 relay 面

运行位置：

- Cloudflare Workers

## 4.3 packages/shared

职责：

- DTO
- schema
- feature flags
- error codes
- relay capability matrix

## 5. 技术栈建议

## 5.1 推荐栈

- Runtime: `TypeScript`
- Edge framework: `Hono`
- Validation: `zod`
- Worker build: `Wrangler`
- Frontend: `React + Vite`
- Async: `Queues`
- Hot state: `Durable Objects`
- DB access:
  - D1: 原生 binding
  - Durable Objects: 原生 class binding
  - 外部 DB: 仅在必要时通过桥接服务

## 5.2 不推荐栈

- Go 直编 Workers 作为主实现
- 在 Worker 中复刻 GORM 风格 ORM
- 直接把 Redis 语义压到 KV

## 6. Free 计划模式

### 6.1 可上线能力

- 单站点前端
- 基础用户体系
- 少量 OAuth provider
- 基础 Token 管理
- 轻量 AI relay
- 低频配置管理
- 小规模 usage 聚合

### 6.2 应降级能力

- 复杂后台批处理
- 大规模 usage logs
- 高频配额扣减明细
- 重日志、重审计、重报表
- 高频渠道探测

### 6.3 应外置能力

- 大流量日志存储
- 高频交易型配额账本
- 复杂运营报表
- 大规模渠道健康任务

## 7. 迁移阶段

### 阶段 A：静态前端云边分离

- 前端迁到 Pages
- 继续连接现有后端

### 阶段 B：Edge Auth + Status API

- Worker 接管 `/api/status`
- Worker 接管轻量认证入口

### 阶段 C：最小 Relay Gateway

- 接入最关键一条 AI relay 路径
- 保留最小日志与限流

### 阶段 D：状态面替换

- 部分元数据迁到 D1
- 热点小状态迁到 Durable Objects
- 轻量异步任务迁到 Queues

### 阶段 E：裁剪式能力补齐

- 只补真正适合 Cloudflare 的能力
- 明确不补不适合 Free 的能力
