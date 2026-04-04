# new-api 到 Cloudflare Free 的可行性研究

## 1. 研究目标

本研究要回答的问题不是“能不能把页面挂到 Cloudflare 上”，而是：

1. 现有 `new-api` 是否能在保持核心行为等价的前提下，迁移为 Cloudflare 原生系统
2. 在 **Cloudflare Free** 计划下，哪些能力可保留，哪些能力必须重写，哪些能力必须下线
3. 应该如何设计 `new-api-cf` 的最小可行架构

## 2. 原项目运行时事实

原项目不是单纯的前后端分离静态站点，而是一个多状态、多后台任务的长生命周期服务：

- 主进程启动 Go/Gin HTTP 服务，并加载嵌入式前端产物  
  参考：[main.go](/Volumes/Work/code/new-api/main.go#L37) [main.go](/Volumes/Work/code/new-api/main.go#L154)
- 服务启动后会拉起多个后台循环任务、缓存同步、批处理和周期刷新  
  参考：[main.go](/Volumes/Work/code/new-api/main.go#L67) [main.go](/Volumes/Work/code/new-api/main.go#L93) [main.go](/Volumes/Work/code/new-api/main.go#L107) [main.go](/Volumes/Work/code/new-api/main.go#L109) [main.go](/Volumes/Work/code/new-api/main.go#L113) [main.go](/Volumes/Work/code/new-api/main.go#L125) [main.go](/Volumes/Work/code/new-api/main.go#L135)
- 初始化阶段显式依赖 SQL DB、日志 DB、Redis、系统监控、自定义 OAuth provider 装载  
  参考：[main.go](/Volumes/Work/code/new-api/main.go#L264) [main.go](/Volumes/Work/code/new-api/main.go#L283) [main.go](/Volumes/Work/code/new-api/main.go#L288) [main.go](/Volumes/Work/code/new-api/main.go#L294) [main.go](/Volumes/Work/code/new-api/main.go#L308)
- 当前官方部署模型就是 `new-api + postgres + redis` 三件套  
  参考：[docker-compose.yml](/Volumes/Work/code/new-api/docker-compose.yml#L17)
- 数据层采用 GORM 直连 PostgreSQL / MySQL / SQLite  
  参考：[model/main.go](/Volumes/Work/code/new-api/model/main.go#L122)
- Redis 是标准连接式 Redis 客户端，并承载缓存、限流、配额等能力  
  参考：[common/redis.go](/Volumes/Work/code/new-api/common/redis.go#L16)
- 系统存在 SSE / WebSocket / Passkey / OAuth / 流式代理等多类交互路径  
  参考：[main.go](/Volumes/Work/code/new-api/main.go#L165) [controller/relay.go](/Volumes/Work/code/new-api/controller/relay.go#L31) [router/api-router.go](/Volumes/Work/code/new-api/router/api-router.go#L61)
- 前端是独立 Vite/React 构建产物，天然适合静态托管  
  参考：[web/package.json](/Volumes/Work/code/new-api/web/package.json#L44)
- 前端请求主要通过相对路径 `/api/*`，适合 Pages + Worker/API Gateway 分层  
  参考：[web/src/helpers/api.js](/Volumes/Work/code/new-api/web/src/helpers/api.js#L232)

## 3. Cloudflare Free 计划关键约束

以下约束均来自 Cloudflare 官方文档：

### 3.1 Workers / Pages Functions

- Workers Free：`100,000 requests/day`
- HTTP request CPU time：`10ms`
- 内存：`128 MB`
- Worker 大小：`3 MB`
- Cron Triggers：`5 per account`

官方来源：

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/

### 3.2 Pages

- 静态资源请求免费
- Pages Functions 仍按 Workers 计费与配额
- Free 静态文件限制：
  - `20,000 files`
  - `25 MiB per file`
  - `500 builds / month`

官方来源：

- https://developers.cloudflare.com/pages/platform/limits/
- https://developers.cloudflare.com/pages/functions/
- https://developers.cloudflare.com/pages/functions/pricing/

### 3.3 D1

- Free：
  - `5M rows read / day`
  - `100k rows written / day`
  - `5 GB storage`
- 单次 Worker 调用：
  - `50 queries`
- D1 是 Worker Binding 模型，不是 PostgreSQL/MySQL 连接串模型

官方来源：

- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/

### 3.4 KV

- Free：
  - `100k reads / day`
  - `1k writes / day`
- KV 是 eventually consistent，不适合强一致计数器、热点原子状态、Redis 语义替代

官方来源：

- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/kv/concepts/how-kv-works/

### 3.5 Hyperdrive / Containers

- Hyperdrive Free：`100k database queries/day`
- Cloudflare Containers：Free 不可用

官方来源：

- https://developers.cloudflare.com/hyperdrive/platform/pricing/
- https://developers.cloudflare.com/containers/pricing/

## 4. CSE 控制结构分析

### 4.1 被控对象

当前 `new-api` 是：

- 常驻 Go HTTP 服务
- SQL 持久化
- Redis 高速状态层
- 多后台任务协调器
- 流式 AI relay gateway

### 4.2 参考输入

迁移后仍需保留的核心能力：

- 统一 AI API 入口
- 用户 / Token / 渠道 / 计费 / 日志 / 配额
- 管理后台
- 至少一部分 OAuth / JWT / Trusted Header / 自定义认证
- 流式代理基础能力

### 4.3 主要误差

Cloudflare Free 原生环境与当前运行模型之间的误差主要集中在三层：

#### 数据面误差

- Workers 可以处理 HTTP、Streams、WebSockets，但 CPU 时间非常紧
- AI relay 请求往往不是“纯转发”，而是伴随限流、配额、日志、统计、渠道状态处理

#### 状态面误差

- 当前项目依赖 SQL + Redis
- D1 不能直接承载现有 GORM 模型
- KV 不适合取代 Redis 热路径
- Hyperdrive Free 的查询额度不适合作为高频业务数据库接入层

#### 控制面误差

- 原系统依赖多个后台循环任务、ticker、批量更新器、周期同步
- Workers Free 不提供常驻进程模型
- Cron 数量也不足以覆盖原系统所有定时控制逻辑

## 5. 第一性原理结论

### 5.1 哪些可以直接迁移

- 管理前端静态资源
- 公共营销页、帮助页、隐私页
- 一部分纯读取型边缘接口
- 少量低频鉴权前置逻辑

### 5.2 哪些不能原样迁移

- Go/Gin 常驻服务本体
- GORM 直连 PostgreSQL/MySQL/SQLite 数据层
- Redis 驱动的限流、缓存、配额热路径
- 多后台任务的原有控制结构
- 原样等价的 Passkey / Session / OAuth 状态编排

### 5.3 哪些必须重构

- 状态模型：从“连接式 SQL + Redis”改为“边缘状态 + 可控外部状态”
- 控制模型：从“常驻后台 goroutine”改为“事件驱动 + Cron + Queue + 显式补偿”
- 代理模型：从“后端全功能统一处理”改为“边缘快速判定 + 核心链路最小化”

## 6. Free 计划下的现实目标

`new-api-cf` 在 Free 计划下应定义为：

- 单租户或轻量多租户
- `10` 人以内并发的小规模使用
- 低写入、低后台任务密度
- 以推理代理与基础用户管理为主
- 不追求与原版 `new-api` 的全量功能等价

不应定义为：

- 原版生产级 `new-api` 的 Cloudflare 原生替代
- 完整多渠道、完整后台任务、完整配额与日志体系的无损迁移

## 7. 推荐的资源分层

### 7.1 Free 友好型资源映射

- `Cloudflare Pages`
  - 管理前端
  - 登录页
  - 静态文档页

- `Workers`
  - `/api/status`
  - 轻量登录态校验
  - Token 验证
  - 轻量 AI relay 路由
  - 外部 OAuth 重定向编排

- `D1`
  - 低写入配置表
  - 渠道元数据
  - 用户基础资料
  - 小规模审计索引

- `KV`
  - 只读配置缓存
  - Feature flags
  - 短期低一致性缓存

- `R2`
  - 大对象归档
  - 报表导出文件
  - 静态附件

- `Durable Objects`
  - 串行化热点状态
  - 简化版租户级配额计数
  - 轻量会话协调

- `Queues`
  - 非核心异步日志
  - 聚合任务
  - 延迟补偿

### 7.2 不建议放在 Free 原生层的能力

- 高频计费流水
- 高频日志写入
- 全量 usage logs 明细
- 大规模渠道健康检查
- 高密度 token/quota 原子扣减
- Redis 级热点读写

## 8. 复杂性转移账本

| 原复杂性位置 | 新位置 | 收益 | 新成本 | 新失效模式 |
| --- | --- | --- | --- | --- |
| Go 常驻进程后台任务 | Cron / Queues / Durable Objects | 更贴合边缘平台 | 控制逻辑碎片化 | 调度遗漏、重试积压 |
| GORM + PostgreSQL/MySQL | D1 / 外部 DB adapter | 更靠近 Cloudflare 原生 | ORM 语义丢失、查询重写 | 查询额度耗尽、模型失配 |
| Redis 热路径 | DO / KV / 内存边缘缓存 | 降低外部状态依赖 | 一致性与串行化成本增加 | 配额误差、热点对象拥堵 |
| 全量后端一体化 | 边缘 API + 静态前端 + 可选外部核心服务 | 系统边界更清晰 | 分布式调试更复杂 | 链路跨层诊断困难 |

## 9. 推荐结论

### 9.1 可行方案

做一个 **Cloudflare 重构版子系统**，目标是：

- 保留前端管理界面
- 保留最关键的 API gateway 能力
- 保留基础用户与 Token 管理
- 保留最基础的 OAuth / JWT 认证入口
- 弱化日志、报表、后台批处理和复杂运营功能
- 明确面向 `10` 人以内并发的小规模场景

### 9.2 不可取方案

试图把当前 Go 仓库直接编译或包装后，原样放进 Cloudflare Free 的运行模型中。

原因不是“语言不支持”这么简单，而是：

- 运行时模型不匹配
- 状态面不匹配
- 控制面不匹配
- Free 额度不匹配

## 10. next baseline

`new-api-cf` 的第一阶段应是：

1. 固化新的顶层架构
2. 确定 Cloudflare 原生最小能力集
3. 搭建最小 Worker API 原型
4. 拆出共享契约与数据模型
5. 只实现“最小可运行边缘版”，不追求一次性全量迁移
