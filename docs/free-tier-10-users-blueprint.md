# new-api-cf Free 计划 10 人并发蓝图

## 1. Control Contract

### Primary Setpoint

设计一个 **Cloudflare Worker-first** 的 `new-api-cf`，在 **Cloudflare Free** 计划内支持 **10 人以内并发** 的小规模使用场景。

### Acceptance

- 架构必须主要建立在 Cloudflare Free 可用资源之上
- 核心链路必须可闭环：
  - 登录
  - 获取可用模型/渠道
  - 发起一次基础 AI 请求
  - 返回结果
- 文档中必须明确：
  - 哪些能力保留
  - 哪些能力降级
  - 哪些能力外置

### Guardrail Metrics

- Workers Free 请求量不超过 `100,000/day`
- 单次 Worker 调用外部子请求控制在 `<= 50`
- 高频写操作不依赖 KV
- 异步队列总操作量控制在 `10,000/day` 量级内
- D1 写入控制在 `100,000 rows/day` 以下

### Sampling Plan

- 以“单用户请求链路”和“10 用户并发短峰值”两类场景做容量估算
- 先看每次请求会打到多少 Cloudflare 内部资源，再估算日级别上限

### Known Delays / Delay Budget

- KV 为最终一致性，不能用于强一致配额路径
- Queues 为异步链路，只能承接非主链逻辑
- D1 适合低写入结构化状态，不适合高频热更新

### Recovery Target

- 任一 Free 资源触顶时，系统应优先退化非核心能力，而不是打断核心 AI 请求入口

### Rollback Trigger

- 若设计需要把高频配额扣减、全量 usage logs 或高密度后台任务强行塞进 Free 原生资源，则本轮设计默认失败

### Constraints

- 不追求与原版 `new-api` 全量功能等价
- 必须优先采用 Worker-native 设计，而不是进程迁移思路
- 优先使用 Cloudflare Free 原生资源

### Boundary

- 只讨论 `new-api-cf` 新架构
- 不修改原版 `new-api` 运行时

### Coupling Notes

- 数据面会耦合 Worker / D1 / DO / KV / Queues
- 控制面会耦合 Cron / Queue consumer / DO alarms
- 前端会耦合 Pages + Worker API 域名与 OAuth 回调域名

### Approximation Validity

- 本蓝图假设场景是：
  - 小团队内部使用
  - 10 人以内并发
  - 低到中等请求频率
  - 不追求完整账务与全量审计

### Actuator Budget

- 允许调整技术栈
- 允许重新定义数据模型
- 允许拆分服务边界

### Risks

- Free 配额下最容易先触顶的是请求数、D1 写入、Queues 操作数
- 若把 usage logs 设计成主链同步写入，系统会过早失稳
- 若把 Redis 语义压到 KV，会出现一致性与限流失真

## 2. Free 资源池事实

以下是本蓝图直接依赖的 Cloudflare Free 资源边界：

- Workers Free
  - `100,000 requests/day`
  - `10ms CPU time/request`
  - `128MB memory`
  - `50 external subrequests/request`
  - `1000 internal service subrequests/request`
  - `5 cron triggers/account`
- Pages Free
  - 静态资源免费
  - Functions 计入 Workers 配额
  - `20,000 files`
  - `25 MiB/file`
  - `500 builds/month`
- D1 Free
  - `5M rows read/day`
  - `100k rows written/day`
  - `5GB storage`
  - `50 queries/invocation`
- KV Free
  - `100k reads/day`
  - `1k writes/day`
  - eventually consistent
- Durable Objects Free
  - `100,000 requests/day`
  - `13,000 GB-s/day`
  - `5GB storage/account`
  - SQLite backend 可用
- Queues Free
  - `10,000 operations/day`
  - retention `24h`

官方来源：

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/pages/platform/limits/
- https://developers.cloudflare.com/pages/functions/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/kv/concepts/how-kv-works/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/queues/platform/pricing/

## 3. 推荐控制拓扑

### 总体设计部

`docs/` 下的蓝图和契约文档就是当前 `new-api-cf` 的总体设计部基线。

### 控制结构

- 控制面主落点：
  - Worker gateway
  - Durable Objects
  - Cron
  - Queues
- 数据面主落点：
  - Worker relay
  - Pages 前端
- 状态面主落点：
  - D1
  - Durable Objects SQLite
  - KV
  - R2

### 边界冻结

当前冻结边界：

- 不引入外部 PostgreSQL / Redis 作为首选方案
- 不按原版 `new-api` 的 SQL schema 机械复刻
- 不在主链同步写全量 usage logs

## 4. 推荐资源链路

```text
User
  -> Pages (admin-web)
  -> API Worker (edge-gateway)
     -> Auth DO
     -> Tenant/User D1
     -> Model/Channel D1
     -> KV read cache
     -> Relay Worker module
        -> Upstream AI provider
     -> Async Queue
        -> Usage Aggregator Worker
           -> D1 aggregate tables
           -> R2 archived logs
```

## 5. 为什么不要全塞进一个 Worker

如果把所有能力都压进一个 Worker，会同时触发三个问题：

- 控制面耦合过高
- 冷启动与 CPU 时间预算更紧
- 调试与回滚颗粒度太粗

因此推荐最少拆成三层：

### 5.1 Pages

职责：

- 静态前端
- 登录页面
- 设置页面
- 控制台页面

### 5.2 API Gateway Worker

职责：

- Session / Token 校验
- API 路由
- 轻量限流
- 租户级路由
- 请求规整

### 5.3 State / Async Workers

职责：

- DO 处理热点状态
- Queue Consumer 处理异步日志与聚合
- Cron 处理低频同步与清理

## 6. 能力保留策略

### 6.1 建议保留

- 基础用户体系
- API key / token 管理
- 基础渠道管理
- 模型列表
- 最小 relay gateway
- OAuth / JWT 的轻量版本
- 基础管理员设置

### 6.2 建议降级

- 渠道探测
- 上游模型自动同步
- usage logs 明细
- 复杂报表
- 高精度计费明细

### 6.3 建议外置或后置

- 大规模日志分析
- 全量审计归档
- 高频配额账本
- 重型后台管理任务

## 7. 能力矩阵：cf 版 vs 原版

| 能力 | 原版 new-api | Free 版 new-api-cf 建议 |
| --- | --- | --- |
| 管理前端 | 完整 | 保留核心页 |
| 用户管理 | 完整 | 保留 |
| Token 管理 | 完整 | 保留 |
| 渠道管理 | 完整 | 保留核心字段 |
| AI relay | 完整 | 保留主流模型主链 |
| OAuth / JWT / Trusted Header | 完整 | 保留轻量版 |
| Passkey | 可选完整 | 暂缓或后置 |
| 全量 usage logs | 完整 | 不保留主链明细 |
| 实时报表 | 完整 | 聚合后弱化 |
| 周期任务 | 多类常驻 | 改为 Cron/Queue/DO alarms |
| Redis 热缓存 | 完整 | 改为 DO + KV 分层 |
| SQL 复杂 schema | 完整 | 改为 D1 轻量 schema |

## 8. 10 人并发容量推演

目标场景不是公网大流量，而是：

- 10 人以内并发
- 每人偶发请求
- 以控制台 + 小规模 API 调用为主

### 8.1 粗略预算

假设：

- 每天 10 人
- 每人 100 次控制台/API 请求
- 每天约 1,000 次前台/后台 API 请求
- 每次 API 调用额外触发 2~5 次内部子请求

则：

- Workers `100,000/day` 足够
- D1 `5M read/day` 足够
- D1 `100k write/day` 只要不写全量 usage 明细，也足够
- Queues `10,000 ops/day` 需要严格控制，只能用来做轻量聚合和非核心异步任务
- KV `1k writes/day` 只适合配置和少量缓存刷新

### 8.2 真正的瓶颈

Free 模式下最先爆的通常不是并发本身，而是：

- 每次请求的写放大
- 日志写放大
- 队列操作放大
- 过多后台同步任务

## 9. 推荐的最小产品定义

`new-api-cf` Free 版最小产品应是：

- 一个 Cloudflare Pages 管理界面
- 一个 Worker API gateway
- 一个最小 AI relay
- 一个轻量用户与 token 系统
- 一个低写入配置存储层
- 一个简化的异步 usage 聚合器

而不是：

- 原版 `new-api` 的全量平替

