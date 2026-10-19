# 采集器服务端聚合 + 移除本地 IndexedDB 子系统

日期：2026-06-25
分支：`feat/background-traffic-collector`

## 背景与问题

流量页（`pages/traffic.vue`）选择"最近一个月"时**直接拉不到数据 / 超时**。

根因不是加载方式，而是接口设计：

1. `GET /api/logs`（`collector/server.ts:128`）返回时间范围内**全部原始连接行**——无聚合、无分页、无 `LIMIT`。`collector/store.ts:67` 的 SQL 直接 `SELECT ... WHERE backend=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`。一个月在繁忙节点可达几十万~上百万行。
2. collector 把整个数组 `JSON.stringify` → HTTP 传输 → 前端 `dataUsageLogsSchema.parse(整个数组)` → 再在 JS 里 `forEach` 聚合。月级数据量下解析即卡死。
3. `fetchData` 里 `getAggregatedData` + `getTrafficTrend`（+ `loadSubStats`）各自独立调用 `source.query()`，同一个月的全量原始数据被**重复拉取 3 遍**。

## 目标

- 一个月范围也能**秒开**，且前端展示**完整**（不截断、所有维度与下钻照常）。
- 移除已不再使用的本地 IndexedDB 数据用量子系统，采集器成为**唯一**数据源。

## 决策（已与用户确认）

1. **服务端聚合**：新增一个**通用**聚合接口覆盖全部在用函数（否决"每函数一个专用接口"——重复且面大）。
2. **不保留本地 IndexedDB 回退**：完整删除本地数据用量子系统（含 `connections.ts` 客户端逐连接采集、`enableDataUsageTracking` 开关、保留期 UI）。采集器唯一。
3. 采集器**未启用/未配置**时，流量页显示**空状态 + 去配置提示**（不静默回退）。

> 关键简化：因采集器是唯一数据源，聚合只存在于 SQL 一处，前端**不需要** JS 聚合 helper，`source.query` 与 `utils/db.ts` 一并消失。

---

## 数据契约（新增）

前端类型放 `~/types`，collector 侧在 `collector/types.ts` 定义形状兼容的镜像（沿用现有 mirror 注释惯例）。

```ts
type Dimension = 'sourceIP' | 'host' | 'outbound' | 'process' | 'inboundUser'
type GroupBy = Dimension | 'time'

interface AggregateQuery {
  start: number
  end: number
  groupBy: GroupBy
  filters?: Partial<Record<Dimension, string>> // 0~2 个等值过滤
  bucketMs?: number // groupBy === 'time' 时必填
}

// 维度分组：label 为字符串；时间分桶：label 为分桶起始时间戳(number)
interface AggregateRow {
  label: string | number
  upload: number
  download: number
  count: number
}
```

---

## 组件设计

### 1. Collector — `collector/store.ts`

新增 `aggregate(backend, query): AggregateRow[]`：

- 列名从**白名单**取（`Dimension` 固定集合），防注入；值一律绑定参数。
- 维度分组：
  ```sql
  SELECT <groupCol> AS label, SUM(upload) AS upload, SUM(download) AS download, COUNT(*) AS count
    FROM data_usage_logs
   WHERE backend = ? AND timestamp >= ? AND timestamp <= ?
     [AND <filterCol> = ? ...]
   GROUP BY <groupCol>
  ```
- 时间分桶（整数除法）：
  ```sql
  SELECT (timestamp / ?) * ? AS label, SUM(upload) AS upload, SUM(download) AS download, COUNT(*) AS count
    FROM data_usage_logs
   WHERE backend = ? AND timestamp >= ? AND timestamp <= ?
     [AND <filterCol> = ? ...]
   GROUP BY timestamp / ?
   ORDER BY label ASC
  ```
- 复用现有索引 `idx_backend_timestamp`。聚合在 SQLite 内部完成，只回聚合行，**不再序列化原始行**。**无 `LIMIT`** → 展示完整。
- `store.query` / `clearBackend` / 其余方法**不变**。

### 2. Collector — `collector/server.ts`

新增 `GET /api/aggregate`：

- Query 参数：`backend`、`start`、`end`、`groupBy`、`bucket`（time 时必填），过滤参 `fSourceIP` / `fHost` / `fOutbound` / `fProcess` / `fInboundUser`（全部可选）。
- 校验：`groupBy` 不在白名单 → 400；`groupBy=time` 缺/非法 `bucket` → 400；未知过滤键忽略；`backend` 缺失/非法 → 400（沿用 `backendParam`）。
- 鉴权 / CORS / OPTIONS 走现有逻辑。
- `GET /api/logs`（原始导出）**保留**（仍有测试），但**已不再被仪表盘消费**——加注释说明。`DELETE /api/logs` 保留（清空仍用）。

### 3. 前端 — `composables/useDataUsageSource.ts`

- 接口改为 `aggregate(query: AggregateQuery): Promise<AggregateRow[]>` + `clearCollectorData()` + `configureCollector()` + 暴露 `ready`（采集器是否就绪）。
- **删除** `query()`、对 `~/utils/db` 的依赖、`db.query` 回退分支、`DataUsageLog` schema/import。
- `aggregate`：拼 `/api/aggregate` URL（值 `encodeURIComponent`）→ `fetch` → Zod 解析。维度结果与时间结果各用一个 schema（label string vs number）。`!ready` 时返回 `[]`（页面由 `ready` 控制空状态，不在此静默回退）。

### 4. 前端 — `composables/useDataUsage.ts`

- 6 个在用函数改为**薄包装**：构造 `AggregateQuery` → `source.aggregate` → 映射成 `AggregatedData`（`total = upload + download`）。
  - `getAggregatedData(type, s, e)` → `{groupBy: type}`
  - `getSubStatsByHost(dim, label, s, e)` → `{groupBy: 'host', filters: {[dim]: label}}`
  - `getProxyStatsByHost(dim, parent, host, s, e)` → `{groupBy: 'outbound', filters: {host, [dim]: parent}}`
  - `getDevicesByHost(host, s, e)` → `{groupBy: 'sourceIP', filters: {host}}`
  - `getDevicesByProxyAndHost(proxy, host, s, e)` → `{groupBy: 'sourceIP', filters: {outbound: proxy, host}}`
  - `getTrafficTrend(s, e, bucketMs)` → `{groupBy: 'time', bucketMs}`，**补零逻辑保留在 composable**（服务端只回非空桶，composable 在 `[start, end]` 上补满空桶，保持图表连续）。
- **删除** `getHostDetailStats`（死代码）。

### 5. 前端 — `pages/traffic.vue`

- 新增 `ready = computed(() => source.ready)`；`!ready` → 渲染**空状态 + 去 `/config` 的提示**，跳过 `fetchData`。
- **删除**"数据保留期"下拉（`retentionOptions` / `selectedDataRetention` 及模板，保留期由采集器管）。
- `handleClearAll` 永远走 `clearCollectorData()`（删除 `connectionsStore.clearDataUsage()` 分支）。
- 函数签名不变 → 其余排序/汇总/下钻逻辑不动。

### 6. 移除本地数据用量子系统

| 文件                           | 改动                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `utils/db.ts`                  | **整文件删除**（`DataUsageDB` + `DataUsageLog`）                                                                                                                                                                                                                                                                                                                                                                                   |
| `stores/connections.ts`        | 删除 `db`/`DataUsageLog` import、`dataRetention`、`logBuffer`/`flushTimeout`/`getDataUsageBufferKey`/`flushLogs`/`scheduleFlush`、`connectionLastData`、`updateDataUsage`、`enableDataUsageTracking` 调用分支、`removeDataUsageEntry`（孤儿）；`clearDataUsage` 简化（不再有本地存储可清，restart 分支仅保留 `clearChartHistory`）；审计并移除随之失效的 `baselineTotals`/`hasInitializedSession`/`resetConnectionTracking` 等残留 |
| `stores/config.ts`             | 删除 `enableDataUsageTracking`（定义 / `resetConfig` / return）                                                                                                                                                                                                                                                                                                                                                                    |
| `pages/config.vue`             | 删除 `enableDataUsageTracking` 开关 UI                                                                                                                                                                                                                                                                                                                                                                                             |
| `i18n/locales/{en,zh,ru}.json` | 删除 `enableDataUsageTracking`、`enableDataUsageTrackingDesc`、`dataRetention`、`collectorManagesRetention`；新增空状态文案（如 `collectorNotConfigured` / `collectorNotConfiguredDesc` / `goToSettings`）。保留 `forever`/`lastHour`/`lastDay`/`lastMonth`（与 timeRange 共用）                                                                                                                                                   |

> `enableBackgroundCollector` / `collectorURL` / `collectorToken` 及 `CollectorBackends` 全部**保留**——现在唯一的数据源配置。

---

## 错误处理

- `aggregate` 请求失败 → 抛错，`traffic.vue` 现有 `try/catch` 记录并保持上次数据（不崩）。
- 采集器未就绪 → `ready=false` → 空状态（不发请求、不报错）。
- 服务端非法参数 → 400 + JSON `{error}`；内部异常 → 500（沿用现有兜底）。

## 测试（TDD）

- `collector/__tests__/store.spec.ts`：`aggregate` 维度分组 / 时间分桶 / 单&多过滤 / backend 隔离 / 空范围 / 无 LIMIT 完整性。
- `collector/__tests__/server.spec.ts`：`/api/aggregate` 鉴权、`backend` 必填、`groupBy` 与 `bucket` 校验、过滤参透传、聚合正确性。
- `composables/__tests__/useDataUsageSource.spec.ts`：重写为采集器唯一——`aggregate` URL 构造、Zod 解析、`ready` 逻辑、`!ready` 返回 `[]`。
- `composables/__tests__/useDataUsage.spec.ts`（新增）：6 个包装器构造正确 `AggregateQuery`，映射 `AggregatedData` 正确；trend 补零。
- `stores/__tests__/connections.spec.ts`：移除本地数据用量相关用例与 `db` mock；保留 `restructRawMsgToConnection` 等。
- 全量 `typecheck` + `test` 通过。

## 影响范围小结

- **改动**：`collector/store.ts`、`collector/server.ts`、`collector/types.ts`、`composables/useDataUsageSource.ts`、`composables/useDataUsage.ts`、`pages/traffic.vue`、`pages/config.vue`、`stores/connections.ts`、`stores/config.ts`、`types/index.ts`、`i18n/locales/{en,zh,ru}.json` + 对应测试。
- **删除**：`utils/db.ts`、`getHostDetailStats`、`removeDataUsageEntry`、本地采集/保留/清空逻辑。
- **保留不动**：`/api/logs` 路由、采集器后端管理、连接表与速度图逻辑。

## 非目标（YAGNI）

- 不做客户端分块/进度条（服务端聚合后单请求即快）。
- 不加聚合结果缓存（每次只回几百行）。
- 不为聚合新增额外 SQL 索引（现有 `idx_backend_timestamp` 足够；如后续仍慢再评估覆盖索引）。
- 不保留任何本地存储模式。
