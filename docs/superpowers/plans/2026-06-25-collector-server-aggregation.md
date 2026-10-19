# 采集器服务端聚合 + 移除本地 IndexedDB 子系统 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把流量页的"拉全量原始行→浏览器聚合"改成采集器端 SQL 聚合，使一个月范围秒开；并移除已废弃的本地 IndexedDB 数据用量子系统。

**Architecture:** 采集器新增一个通用聚合接口（维度分组 / 时间分桶 / 0~2 等值过滤，无 LIMIT）。前端只剩"请求 + 解析聚合结果"，采集器成为唯一数据源；采集器未配置时流量页显示空状态。本地采集/存储/保留逻辑整体删除。

**Tech Stack:** Node `node:sqlite` (collector)、Nuxt 3 + Vue 3 + Pinia、Zod、Vitest。

参考规格：`docs/superpowers/specs/2026-06-25-collector-server-aggregation-design.md`

**测试命令约定：**

- 单个前端/collector 单测文件：`pnpm vitest run <path>`
- 全量单测：`pnpm test:unit`
- 前端类型检查：`pnpm typecheck`
- collector 类型检查：`pnpm typecheck:collector`

---

## Task 1: collector 聚合数据契约 + `store.aggregate()`

**Files:**

- Modify: `collector/types.ts`（新增聚合类型 + `DIMENSIONS` 常量）
- Modify: `collector/store.ts`（`Store` 接口 + `aggregate` 实现）
- Test: `collector/__tests__/store.spec.ts`

- [ ] **Step 1: 在 `collector/types.ts` 末尾追加聚合契约**

```ts
export const DIMENSIONS = [
  'sourceIP',
  'host',
  'outbound',
  'process',
  'inboundUser',
] as const

export type Dimension = (typeof DIMENSIONS)[number]
export type GroupBy = Dimension | 'time'

export interface AggregateQuery {
  start: number
  end: number
  groupBy: GroupBy
  filters?: Partial<Record<Dimension, string>>
  bucketMs?: number
}

export interface AggregateRow {
  label: string | number
  upload: number
  download: number
  count: number
}
```

- [ ] **Step 2: 写失败测试**（追加到 `collector/__tests__/store.spec.ts` 的 `describe` 内）

```ts
it('aggregates by a dimension with SUM and COUNT', () => {
  store.insertLogs(A, [
    makeLog({ outbound: 'PROXY', upload: 10, download: 20 }),
    makeLog({ outbound: 'PROXY', upload: 5, download: 5 }),
    makeLog({ outbound: 'DIRECT', upload: 1, download: 2 }),
  ])

  const rows = store.aggregate(A, {
    start: 0,
    end: 100000,
    groupBy: 'outbound',
  })
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]))

  expect(byLabel.PROXY).toMatchObject({ upload: 15, download: 25, count: 2 })
  expect(byLabel.DIRECT).toMatchObject({ upload: 1, download: 2, count: 1 })
})

it('applies equality filters before grouping', () => {
  store.insertLogs(A, [
    makeLog({ host: 'a.com', outbound: 'PROXY', upload: 10 }),
    makeLog({ host: 'b.com', outbound: 'PROXY', upload: 7 }),
    makeLog({ host: 'a.com', outbound: 'DIRECT', upload: 3 }),
  ])

  const rows = store.aggregate(A, {
    start: 0,
    end: 100000,
    groupBy: 'host',
    filters: { outbound: 'PROXY' },
  })

  expect(rows.map((r) => r.label).sort()).toEqual(['a.com', 'b.com'])
  expect(rows.find((r) => r.label === 'a.com')!.upload).toBe(10)
})

it('buckets by time with integer division', () => {
  store.insertLogs(A, [
    makeLog({ timestamp: 500, upload: 1 }),
    makeLog({ timestamp: 1500, upload: 2 }),
    makeLog({ timestamp: 1700, upload: 4 }),
  ])

  const rows = store.aggregate(A, {
    start: 0,
    end: 10000,
    groupBy: 'time',
    bucketMs: 1000,
  })

  expect(rows.map((r) => [Number(r.label), r.upload])).toEqual([
    [0, 1],
    [1000, 6],
  ])
})

it('scopes aggregation to the requested backend', () => {
  store.insertLogs(A, [makeLog({ outbound: 'PROXY', upload: 10 })])
  store.insertLogs(B, [makeLog({ outbound: 'PROXY', upload: 99 })])

  const rows = store.aggregate(A, {
    start: 0,
    end: 100000,
    groupBy: 'outbound',
  })
  expect(rows).toEqual([
    { label: 'PROXY', upload: 10, download: 200, count: 1 },
  ])
})

it('returns an empty array for a range with no rows', () => {
  store.insertLogs(A, [makeLog({ timestamp: 60000 })])
  expect(store.aggregate(A, { start: 0, end: 100, groupBy: 'host' })).toEqual(
    [],
  )
})

it('throws when grouping by time without a bucket', () => {
  expect(() =>
    store.aggregate(A, { start: 0, end: 1, groupBy: 'time' }),
  ).toThrow()
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run collector/__tests__/store.spec.ts`
Expected: FAIL（`store.aggregate is not a function`）

- [ ] **Step 4: 实现 `aggregate`**

`collector/store.ts` 已有 `import type { DataUsageLog } from './types'` 与 `import { DatabaseSync } from 'node:sqlite'`。把类型 import 扩成下面两行（新增 `AggregateQuery`/`AggregateRow`/`Dimension` 与 `DIMENSIONS` 值导入），`DatabaseSync` 那行不动：

```ts
import type {
  AggregateQuery,
  AggregateRow,
  DataUsageLog,
  Dimension,
} from './types'
import { DIMENSIONS } from './types'
```

在 `Store` 接口里加一行（紧跟 `query`）：

```ts
  aggregate: (backend: string, query: AggregateQuery) => AggregateRow[]
```

在 `return { ... }` 对象里、`query(...)` 方法之后插入实现：

```ts
    aggregate(backend, query) {
      const { start, end, groupBy, filters = {}, bucketMs } = query

      const where = ['backend = ?', 'timestamp >= ?', 'timestamp <= ?']
      const whereParams: (string | number)[] = [backend, start, end]
      for (const dim of DIMENSIONS) {
        const v = filters[dim as Dimension]
        if (v !== undefined) {
          where.push(`${dim} = ?`)
          whereParams.push(v)
        }
      }
      const whereSql = where.join(' AND ')

      if (groupBy === 'time') {
        if (!bucketMs || bucketMs <= 0) {
          throw new Error('bucketMs is required for time grouping')
        }
        const sql = `SELECT CAST(timestamp / ? AS INTEGER) * ? AS label,
                            SUM(upload) AS upload, SUM(download) AS download, COUNT(*) AS count
                       FROM data_usage_logs
                      WHERE ${whereSql}
                      GROUP BY CAST(timestamp / ? AS INTEGER)
                      ORDER BY label ASC`
        return db
          .prepare(sql)
          .all(bucketMs, bucketMs, ...whereParams, bucketMs) as unknown as AggregateRow[]
      }

      if (!DIMENSIONS.includes(groupBy as Dimension)) {
        throw new Error(`invalid groupBy: ${groupBy}`)
      }
      const sql = `SELECT ${groupBy} AS label,
                          SUM(upload) AS upload, SUM(download) AS download, COUNT(*) AS count
                     FROM data_usage_logs
                    WHERE ${whereSql}
                    GROUP BY ${groupBy}`
      return db.prepare(sql).all(...whereParams) as unknown as AggregateRow[]
    },
```

> 列名 `groupBy`/`dim` 仅来自 `DIMENSIONS` 白名单常量，值一律绑定参数 → 无注入面。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run collector/__tests__/store.spec.ts`
Expected: PASS（全部）

- [ ] **Step 6: collector 类型检查**

Run: `pnpm typecheck:collector`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add collector/types.ts collector/store.ts collector/__tests__/store.spec.ts
git commit -m "feat(collector): store.aggregate for server-side SQL aggregation"
```

---

## Task 2: collector `GET /api/aggregate` 路由

**Files:**

- Modify: `collector/server.ts`
- Test: `collector/__tests__/server.spec.ts`

- [ ] **Step 1: 写失败测试**（追加到 `collector/__tests__/server.spec.ts` 的 `describe` 内）

```ts
it('rejects /api/aggregate without a token', async () => {
  const res = await fetch(`${base}/api/aggregate?backend=${A}&groupBy=host`)
  expect(res.status).toBe(401)
})

it('rejects /api/aggregate without a backend', async () => {
  const res = await fetch(`${base}/api/aggregate?groupBy=host`, {
    headers: auth,
  })
  expect(res.status).toBe(400)
})

it('rejects /api/aggregate with an invalid groupBy', async () => {
  const res = await fetch(
    `${base}/api/aggregate?backend=${encodeURIComponent(A)}&groupBy=nope`,
    {
      headers: auth,
    },
  )
  expect(res.status).toBe(400)
})

it('rejects /api/aggregate groupBy=time without a bucket', async () => {
  const res = await fetch(
    `${base}/api/aggregate?backend=${encodeURIComponent(A)}&groupBy=time`,
    {
      headers: auth,
    },
  )
  expect(res.status).toBe(400)
})

it('aggregates by dimension and honours filters', async () => {
  store.insertLogs(A, [
    makeLog({ host: 'a.com', outbound: 'PROXY', upload: 10, download: 1 }),
    makeLog({ host: 'b.com', outbound: 'PROXY', upload: 7, download: 1 }),
    makeLog({ host: 'a.com', outbound: 'DIRECT', upload: 3, download: 1 }),
  ])

  const res = await fetch(
    `${base}/api/aggregate?backend=${encodeURIComponent(A)}&start=0&end=100000&groupBy=host&fOutbound=PROXY`,
    { headers: auth },
  )

  expect(res.status).toBe(200)
  const rows = (await res.json()) as { label: string; upload: number }[]
  expect(rows.map((r) => r.label).sort()).toEqual(['a.com', 'b.com'])
  expect(rows.find((r) => r.label === 'a.com')!.upload).toBe(10)
})

it('aggregates by time bucket', async () => {
  store.insertLogs(A, [
    makeLog({ timestamp: 500, upload: 1 }),
    makeLog({ timestamp: 1500, upload: 2 }),
  ])

  const res = await fetch(
    `${base}/api/aggregate?backend=${encodeURIComponent(A)}&start=0&end=10000&groupBy=time&bucket=1000`,
    { headers: auth },
  )

  expect(res.status).toBe(200)
  const rows = (await res.json()) as { label: number; upload: number }[]
  expect(rows).toEqual([
    { label: 0, upload: 1, download: 200, count: 1 },
    { label: 1000, upload: 2, download: 200, count: 1 },
  ])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run collector/__tests__/server.spec.ts`
Expected: FAIL（聚合路由返回 404）

- [ ] **Step 3: 实现路由**

`collector/server.ts` 已有 `import { normalizeBackend } from './backends'`（保持不动）。新增两行 import（`DIMENSIONS` 值 + `Dimension`/`GroupBy` 类型，均来自 `./types`）：

```ts
import { DIMENSIONS } from './types'
import type { Dimension, GroupBy } from './types'
```

在 `createServer` 内、`backendParam` 定义之后加一个过滤参映射常量：

```ts
const FILTER_PARAMS: Record<string, Dimension> = {
  fSourceIP: 'sourceIP',
  fHost: 'host',
  fOutbound: 'outbound',
  fProcess: 'process',
  fInboundUser: 'inboundUser',
}
const GROUP_BYS = new Set<string>([...DIMENSIONS, 'time'])
```

在 `GET /api/logs` 处理块**之后**插入新路由：

```ts
if (req.method === 'GET' && url.pathname === '/api/aggregate') {
  const backend = backendParam(url, 'backend')
  if (!backend) {
    json(res, 400, { error: 'backend is required' })
    return
  }
  const groupBy = url.searchParams.get('groupBy') ?? ''
  if (!GROUP_BYS.has(groupBy)) {
    json(res, 400, { error: 'invalid groupBy' })
    return
  }
  const start = Math.max(0, Number(url.searchParams.get('start')) || 0)
  const endParam = Number(url.searchParams.get('end'))
  const end = Number.isFinite(endParam) && endParam > 0 ? endParam : Date.now()

  let bucketMs: number | undefined
  if (groupBy === 'time') {
    const b = Number(url.searchParams.get('bucket'))
    if (!Number.isFinite(b) || b <= 0) {
      json(res, 400, { error: 'bucket is required for time grouping' })
      return
    }
    bucketMs = b
  }

  const filters: Partial<Record<Dimension, string>> = {}
  for (const [param, dim] of Object.entries(FILTER_PARAMS)) {
    const v = url.searchParams.get(param)
    if (v !== null) filters[dim] = v
  }

  json(
    res,
    200,
    store.aggregate(backend, {
      start,
      end,
      groupBy: groupBy as GroupBy,
      filters,
      bucketMs,
    }),
  )
  return
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run collector/__tests__/server.spec.ts`
Expected: PASS（全部）

- [ ] **Step 5: collector 类型检查**

Run: `pnpm typecheck:collector`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add collector/server.ts collector/__tests__/server.spec.ts
git commit -m "feat(collector): GET /api/aggregate endpoint"
```

---

## Task 3: 前端聚合数据契约

**Files:**

- Modify: `types/index.ts`（在 `DataUsageType` 之后追加）

- [ ] **Step 1: 追加类型**

在 `types/index.ts` 的 `DataUsageType` 定义之后插入：

```ts
export type DataUsageGroupBy = DataUsageType | 'time'

export interface DataUsageFilters {
  sourceIP?: string
  host?: string
  outbound?: string
  process?: string
  inboundUser?: string
}

export interface AggregateQuery {
  start: number
  end: number
  groupBy: DataUsageGroupBy
  filters?: DataUsageFilters
  bucketMs?: number
}

export interface AggregateRow {
  label: string | number
  upload: number
  download: number
  count: number
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误（纯新增类型）

- [ ] **Step 3: 提交**

```bash
git add types/index.ts
git commit -m "feat(data-usage): aggregate query/row types"
```

---

## Task 4: 重写 `useDataUsageSource` 为采集器唯一

**Files:**

- Modify: `composables/useDataUsageSource.ts`（整文件重写）
- Test: `composables/__tests__/useDataUsageSource.spec.ts`（整文件重写）

- [ ] **Step 1: 重写 source 实现**

把 `composables/useDataUsageSource.ts` 整文件替换为：

```ts
// composables/useDataUsageSource.ts
import type { AggregateQuery, AggregateRow } from '~/types'
import { z } from 'zod'
import { normalizeBackend } from '~/utils/collector'

export interface DataUsageSource {
  aggregate: (query: AggregateQuery) => Promise<AggregateRow[]>
  clearCollectorData: () => Promise<void>
  configureCollector: () => Promise<void>
  ready: () => boolean
}

const aggregateRowSchema = z.object({
  label: z.union([z.string(), z.number()]),
  upload: z.number(),
  download: z.number(),
  count: z.number(),
})
const aggregateRowsSchema = z.array(aggregateRowSchema)

const FILTER_PARAMS: Record<string, string> = {
  sourceIP: 'fSourceIP',
  host: 'fHost',
  outbound: 'fOutbound',
  process: 'fProcess',
  inboundUser: 'fInboundUser',
}

export function useDataUsageSource(): DataUsageSource {
  const configStore = useConfigStore()
  const endpointStore = useEndpointStore()

  const authHeaders = (): Record<string, string> =>
    configStore.collectorToken
      ? { Authorization: `Bearer ${configStore.collectorToken}` }
      : {}

  const collectorBase = (): string =>
    configStore.collectorURL.replace(/\/$/, '')

  // The collector partitions data per mihomo backend; every call is scoped to
  // the dashboard's currently selected endpoint.
  const currentBackend = (): string => {
    const endpoint = endpointStore.currentEndpoint
    if (!endpoint) return ''
    try {
      return normalizeBackend(endpoint.url)
    } catch {
      return ''
    }
  }

  const ready = (): boolean =>
    Boolean(configStore.enableBackgroundCollector) &&
    collectorBase() !== '' &&
    currentBackend() !== ''

  const aggregate = async (query: AggregateQuery): Promise<AggregateRow[]> => {
    if (!ready()) return []

    const params = new URLSearchParams()
    params.set('backend', currentBackend())
    params.set('start', String(query.start))
    params.set('end', String(query.end))
    params.set('groupBy', query.groupBy)
    if (query.bucketMs) params.set('bucket', String(query.bucketMs))
    for (const [dim, value] of Object.entries(query.filters ?? {})) {
      if (value !== undefined) params.set(FILTER_PARAMS[dim]!, value)
    }

    const res = await fetch(`${collectorBase()}/api/aggregate?${params}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      throw new Error(`Collector request failed with status ${res.status}`)
    }
    return aggregateRowsSchema.parse(await res.json())
  }

  const clearCollectorData = async (): Promise<void> => {
    if (!ready()) {
      throw new Error('Collector is not configured')
    }
    const backend = encodeURIComponent(currentBackend())
    const res = await fetch(`${collectorBase()}/api/logs?backend=${backend}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (!res.ok) {
      throw new Error(`Collector clear failed with status ${res.status}`)
    }
  }

  // Push the dashboard's current mihomo endpoint to the collector; the
  // collector adds it to its collection set (upsert, not replace).
  const configureCollector = async (): Promise<void> => {
    const endpoint = endpointStore.currentEndpoint
    if (!endpoint || !collectorBase()) return
    const res = await fetch(`${collectorBase()}/api/connect`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: endpoint.url,
        secret: endpoint.secret ?? '',
      }),
    })
    if (!res.ok) {
      throw new Error(`Collector configure failed with status ${res.status}`)
    }
  }

  return { aggregate, clearCollectorData, configureCollector, ready }
}
```

- [ ] **Step 2: 重写测试文件**

把 `composables/__tests__/useDataUsageSource.spec.ts` 整文件替换为：

```ts
// composables/__tests__/useDataUsageSource.spec.ts
import type { AggregateQuery } from '~/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDataUsageSource } from '../useDataUsageSource'

const configStore = {
  enableBackgroundCollector: true,
  collectorURL: 'http://collector:9797',
  collectorToken: 'tok',
}
const endpointStore = {
  currentEndpoint: {
    id: 'e1',
    url: 'http://127.0.0.1:9090',
    secret: 'mihomo-secret',
  },
}

vi.stubGlobal('useConfigStore', () => configStore)
vi.stubGlobal('useEndpointStore', () => endpointStore)

const BACKEND = encodeURIComponent('http://127.0.0.1:9090')

beforeEach(() => {
  vi.clearAllMocks()
  configStore.enableBackgroundCollector = true
  configStore.collectorURL = 'http://collector:9797'
  configStore.collectorToken = 'tok'
  endpointStore.currentEndpoint = {
    id: 'e1',
    url: 'http://127.0.0.1:9090',
    secret: 'mihomo-secret',
  }
})

const dimQuery: AggregateQuery = { start: 10, end: 20, groupBy: 'outbound' }

describe('composables/useDataUsageSource', () => {
  it('ready() reflects collector config', () => {
    const source = useDataUsageSource()
    expect(source.ready()).toBe(true)

    configStore.enableBackgroundCollector = false
    expect(source.ready()).toBe(false)
  })

  it('aggregate returns [] without firing a request when not ready', async () => {
    configStore.collectorURL = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const rows = await useDataUsageSource().aggregate(dimQuery)

    expect(rows).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aggregate requests /api/aggregate with backend + groupBy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ label: 'PROXY', upload: 1, download: 2, count: 3 }],
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await useDataUsageSource().aggregate(dimQuery)

    expect(fetchMock).toHaveBeenCalledWith(
      `http://collector:9797/api/aggregate?backend=${BACKEND}&start=10&end=20&groupBy=outbound`,
      { headers: { Authorization: 'Bearer tok' } },
    )
    expect(rows).toEqual([{ label: 'PROXY', upload: 1, download: 2, count: 3 }])
  })

  it('aggregate encodes filters and time bucket', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)

    await useDataUsageSource().aggregate({
      start: 0,
      end: 100,
      groupBy: 'host',
      filters: { outbound: 'PROXY' },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `http://collector:9797/api/aggregate?backend=${BACKEND}&start=0&end=100&groupBy=host&fOutbound=PROXY`,
      { headers: { Authorization: 'Bearer tok' } },
    )

    await useDataUsageSource().aggregate({
      start: 0,
      end: 100,
      groupBy: 'time',
      bucketMs: 1000,
    })
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://collector:9797/api/aggregate?backend=${BACKEND}&start=0&end=100&groupBy=time&bucket=1000`,
      { headers: { Authorization: 'Bearer tok' } },
    )
  })

  it('aggregate throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    )
    await expect(useDataUsageSource().aggregate(dimQuery)).rejects.toThrow(
      /503/,
    )
  })

  it('aggregate rejects malformed rows (schema guard)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [{ label: 1 }] }),
    )
    await expect(useDataUsageSource().aggregate(dimQuery)).rejects.toThrow()
  })

  it('clearCollectorData issues a backend-scoped DELETE', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await useDataUsageSource().clearCollectorData()

    expect(fetchMock).toHaveBeenCalledWith(
      `http://collector:9797/api/logs?backend=${BACKEND}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
    )
  })

  it('clearCollectorData throws when not configured', async () => {
    configStore.collectorURL = ''
    await expect(useDataUsageSource().clearCollectorData()).rejects.toThrow(
      /not configured/i,
    )
  })

  it('configureCollector POSTs the current endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await useDataUsageSource().configureCollector()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://collector:9797/api/connect',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'http://127.0.0.1:9090',
          secret: 'mihomo-secret',
        }),
      },
    )
  })
})
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run composables/__tests__/useDataUsageSource.spec.ts`
Expected: PASS（全部）

> 注：此时 `pnpm typecheck` 会因 `useDataUsage.ts` 仍调用 `source.query` 而报错——在 Task 5 后修复。本步只跑该单测文件。

- [ ] **Step 4: 提交**

```bash
git add composables/useDataUsageSource.ts composables/__tests__/useDataUsageSource.spec.ts
git commit -m "refactor(data-usage): collector-only source with aggregate()"
```

---

## Task 5: 重写 `useDataUsage` 为聚合包装器

**Files:**

- Modify: `composables/useDataUsage.ts`（整文件重写）
- Test: `composables/__tests__/useDataUsage.spec.ts`（新建）

- [ ] **Step 1: 重写 composable**

把 `composables/useDataUsage.ts` 整文件替换为：

```ts
import type { AggregateRow, DataUsageType } from '~/types'
import { useDataUsageSource } from '~/composables/useDataUsageSource'

export interface AggregatedData {
  label: string
  upload: number
  download: number
  total: number
  count: number
}

const toAggregated = (rows: AggregateRow[]): AggregatedData[] =>
  rows.map((r) => ({
    label: String(r.label),
    upload: r.upload,
    download: r.download,
    total: r.upload + r.download,
    count: r.count,
  }))

const byTotalDesc = (a: AggregatedData, b: AggregatedData) => b.total - a.total

export const useDataUsage = () => {
  const source = useDataUsageSource()

  const getAggregatedData = async (
    type: DataUsageType,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({ start: startTime, end: endTime, groupBy: type }),
    )

  const getSubStatsByHost = async (
    dimension: Exclude<DataUsageType, 'host'>,
    label: string,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({
        start: startTime,
        end: endTime,
        groupBy: 'host',
        filters: { [dimension]: label },
      }),
    ).sort(byTotalDesc)

  const getProxyStatsByHost = async (
    dimension: DataUsageType,
    parentLabel: string,
    host: string,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({
        start: startTime,
        end: endTime,
        groupBy: 'outbound',
        filters: { host, [dimension]: parentLabel },
      }),
    ).sort(byTotalDesc)

  const getDevicesByHost = async (
    host: string,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({
        start: startTime,
        end: endTime,
        groupBy: 'sourceIP',
        filters: { host },
      }),
    ).sort(byTotalDesc)

  const getDevicesByProxyAndHost = async (
    proxy: string,
    host: string,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({
        start: startTime,
        end: endTime,
        groupBy: 'sourceIP',
        filters: { outbound: proxy, host },
      }),
    ).sort(byTotalDesc)

  const getTrafficTrend = async (
    startTime: number,
    endTime: number,
    bucketSizeMs: number,
  ): Promise<{ timestamp: number; upload: number; download: number }[]> => {
    const rows = await source.aggregate({
      start: startTime,
      end: endTime,
      groupBy: 'time',
      bucketMs: bucketSizeMs,
    })

    const buckets = new Map<number, { upload: number; download: number }>()
    for (let t = startTime; t <= endTime; t += bucketSizeMs) {
      const bucketStart = Math.floor(t / bucketSizeMs) * bucketSizeMs
      buckets.set(bucketStart, { upload: 0, download: 0 })
    }
    rows.forEach((r) => {
      const bucketStart = Number(r.label)
      const bucket = buckets.get(bucketStart)
      if (bucket) {
        bucket.upload += r.upload
        bucket.download += r.download
      }
    })

    return Array.from(buckets.entries())
      .map(([timestamp, data]) => ({ timestamp, ...data }))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  return {
    getAggregatedData,
    getSubStatsByHost,
    getProxyStatsByHost,
    getDevicesByHost,
    getDevicesByProxyAndHost,
    getTrafficTrend,
  }
}
```

> 已删除死代码 `getHostDetailStats`。`getProxyStatsByHost` 的 `filters: { host, [dimension]: parentLabel }`：当 `dimension==='host'` 时两键合一为 `{ host: parentLabel }`，与旧实现"host 维度下用 parentLabel 作为 host 过滤"语义一致（页面在 host 视图下传 `'sourceIP'` 作为 dimension，不会触发该重叠）。

- [ ] **Step 2: 写测试**（新建 `composables/__tests__/useDataUsage.spec.ts`）

```ts
// composables/__tests__/useDataUsage.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const aggregate = vi.fn()
vi.mock('~/composables/useDataUsageSource', () => ({
  useDataUsageSource: () => ({
    aggregate,
    clearCollectorData: vi.fn(),
    configureCollector: vi.fn(),
    ready: () => true,
  }),
}))

import { useDataUsage } from '../useDataUsage'

beforeEach(() => {
  vi.clearAllMocks()
  aggregate.mockResolvedValue([])
})

describe('composables/useDataUsage', () => {
  it('getAggregatedData groups by the requested dimension and adds total', async () => {
    aggregate.mockResolvedValue([
      { label: 'PROXY', upload: 10, download: 20, count: 2 },
    ])
    const { getAggregatedData } = useDataUsage()

    const out = await getAggregatedData('outbound', 0, 100)

    expect(aggregate).toHaveBeenCalledWith({
      start: 0,
      end: 100,
      groupBy: 'outbound',
    })
    expect(out).toEqual([
      { label: 'PROXY', upload: 10, download: 20, total: 30, count: 2 },
    ])
  })

  it('getSubStatsByHost groups by host filtered by the dimension, sorted desc', async () => {
    aggregate.mockResolvedValue([
      { label: 'a.com', upload: 1, download: 1, count: 1 },
      { label: 'b.com', upload: 10, download: 10, count: 1 },
    ])
    const { getSubStatsByHost } = useDataUsage()

    const out = await getSubStatsByHost('sourceIP', '10.0.0.1', 0, 100)

    expect(aggregate).toHaveBeenCalledWith({
      start: 0,
      end: 100,
      groupBy: 'host',
      filters: { sourceIP: '10.0.0.1' },
    })
    expect(out.map((r) => r.label)).toEqual(['b.com', 'a.com'])
  })

  it('getDevicesByProxyAndHost filters by outbound and host', async () => {
    const { getDevicesByProxyAndHost } = useDataUsage()
    await getDevicesByProxyAndHost('PROXY', 'a.com', 0, 100)

    expect(aggregate).toHaveBeenCalledWith({
      start: 0,
      end: 100,
      groupBy: 'sourceIP',
      filters: { outbound: 'PROXY', host: 'a.com' },
    })
  })

  it('getTrafficTrend zero-fills buckets across the range', async () => {
    aggregate.mockResolvedValue([
      { label: 1000, upload: 5, download: 7, count: 1 },
    ])
    const { getTrafficTrend } = useDataUsage()

    const out = await getTrafficTrend(0, 2000, 1000)

    expect(aggregate).toHaveBeenCalledWith({
      start: 0,
      end: 2000,
      groupBy: 'time',
      bucketMs: 1000,
    })
    expect(out).toEqual([
      { timestamp: 0, upload: 0, download: 0 },
      { timestamp: 1000, upload: 5, download: 7 },
      { timestamp: 2000, upload: 0, download: 0 },
    ])
  })
})
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run composables/__tests__/useDataUsage.spec.ts`
Expected: PASS（全部）

- [ ] **Step 4: 前端类型检查**

Run: `pnpm typecheck`
Expected: 无错误（source + useDataUsage 现已一致）

- [ ] **Step 5: 提交**

```bash
git add composables/useDataUsage.ts composables/__tests__/useDataUsage.spec.ts
git commit -m "refactor(data-usage): useDataUsage as server-aggregate wrappers"
```

---

## Task 6: `traffic.vue` 空状态 + 移除保留期 UI

**Files:**

- Modify: `pages/traffic.vue`

- [ ] **Step 1: 脚本区改动**

替换数据源获取行（原 `const { clearCollectorData } = useDataUsageSource()`）：

```ts
const dataSource = useDataUsageSource()
const { clearCollectorData } = dataSource
const isCollectorReady = computed(() => dataSource.ready())
```

删除保留期相关状态（原 `retentionOptions` + `selectedDataRetention` 两段）。

`fetchData` 开头加就绪守卫：

```ts
const fetchData = async () => {
  if (!isCollectorReady.value) return
  const { startTime, endTime } = getTimeRange()
```

`handleClearAll` 改为始终走采集器：

```ts
async function handleClearAll() {
  if (!confirm(t('confirmClearAll'))) return
  await clearCollectorData()
  await fetchData()
}
```

> 删除保留期 UI（Step 2）与 `handleClearAll` 旧分支后，`configStore` 在本文件已无任何引用（原引用：旧 clearAll 分支 + 保留期 select 的 `:disabled`/`title`，均被删）。因此**删除** `const configStore = useConfigStore()`。

- [ ] **Step 2: 模板改动 — 删除"数据保留期"下拉**

删除整段保留期 `<div class="flex items-center gap-1">...selectedDataRetention...</div>`（含 `t('dataRetention')` 的 label 与 `<select v-model.number="selectedDataRetention">`）。

- [ ] **Step 3: 模板改动 — 加空状态**

在主工作区根节点 `<div class="flex h-full flex-col gap-4 overflow-hidden">` 内最前面包一层条件：未就绪时显示空状态，就绪时显示原有内容。即把现有 header + 主工作区用 `<template v-if="isCollectorReady">` 包裹，并追加 `v-else` 空状态：

```html
<div
  v-else
  class="flex h-full flex-col items-center justify-center gap-4 text-center"
>
  <p class="text-lg font-semibold">{{ t('collectorNotConfigured') }}</p>
  <p class="max-w-md text-sm opacity-60">
    {{ t('collectorNotConfiguredDesc') }}
  </p>
  <NuxtLink to="/config" class="btn btn-sm btn-primary">
    {{ t('goToSettings') }}
  </NuxtLink>
</div>
```

> i18n key `collectorNotConfigured` / `collectorNotConfiguredDesc` / `goToSettings` 在 Task 8 新增。

- [ ] **Step 4: 类型检查 + 构建冒烟**

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add pages/traffic.vue
git commit -m "feat(traffic): collector empty state, drop local retention UI"
```

---

## Task 7: 移除 `connections.ts` 本地数据用量子系统

**Files:**

- Modify: `stores/connections.ts`
- Test: `stores/__tests__/connections.spec.ts`（重写数据用量相关用例）

- [ ] **Step 1: 重写测试**（去掉本地存储断言，保留重启检测/端点切换语义）

把 `stores/__tests__/connections.spec.ts` 整文件替换为：

```ts
import type { WsMsg } from '~/types'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { useConnectionsStore } from '../connections'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
    get length() {
      return Object.keys(store).length
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  }
})()
vi.stubGlobal('localStorage', localStorageMock)

const mockGlobalStore = { clearChartHistory: vi.fn() }
const mockEndpointStore = reactive({ selectedEndpoint: 'endpoint-a' })

vi.stubGlobal('useGlobalStore', () => mockGlobalStore)
vi.stubGlobal('useEndpointStore', () => mockEndpointStore)

function makeConn(id: string, upload: number, download: number) {
  return {
    id,
    upload,
    download,
    chains: ['DIRECT'],
    metadata: {
      sourceIP: '10.0.0.1',
      host: 'example.com',
      destinationIP: '93.184.216.34',
      process: 'curl',
      inboundUser: 'user',
      type: 'http',
    },
  }
}

function makeMsg(
  uploadTotal: number,
  downloadTotal: number,
  connections: ReturnType<typeof makeConn>[],
): WsMsg {
  return { uploadTotal, downloadTotal, connections } as unknown as WsMsg
}

describe('stores/connections restart detection vs endpoint switch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorageMock.clear()
    mockEndpointStore.selectedEndpoint = 'endpoint-a'
  })

  it('does not wipe the chart when switching endpoints', async () => {
    const store = useConnectionsStore()
    store.updateFromWsMsg(makeMsg(1000, 2000, [makeConn('c1', 500, 1000)]))

    mockEndpointStore.selectedEndpoint = 'endpoint-b'
    await nextTick()

    store.updateFromWsMsg(makeMsg(10, 20, [makeConn('c2', 5, 10)]))

    expect(mockGlobalStore.clearChartHistory).not.toHaveBeenCalled()
  })

  it('clears the chart on a real kernel restart on the same endpoint', () => {
    const store = useConnectionsStore()
    store.updateFromWsMsg(makeMsg(1000, 2000, [makeConn('c1', 500, 1000)]))
    store.updateFromWsMsg(makeMsg(10, 20, [makeConn('c1', 5, 10)]))

    expect(mockGlobalStore.clearChartHistory).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run stores/__tests__/connections.spec.ts`
Expected: FAIL（当前 connections.ts 仍 import `~/utils/db`，测试不再 mock 它 → 行为/类型不匹配；以失败为准进入实现）

- [ ] **Step 3: 重写 connections.ts，移除本地数据用量**

对 `stores/connections.ts` 做如下删除/简化：

1. 删除 import：`import type { DataUsageLog } from '~/utils/db'` 与 `import { db } from '~/utils/db'`。
2. 删除 `const configStore = useConfigStore()`（仅 enableDataUsageTracking 用过）。
3. 删除整块"Data usage tracking (IndexedDB buffer)"：`dataRetention`、`logBuffer`、`flushTimeout`、`getDataUsageBufferKey`、`flushLogs`、`scheduleFlush`。
4. 删除 `baselineTotals`、`connectionLastData`、`hasInitializedSession`、`resetConnectionTracking`、`updateDataUsage`、`clearDataUsage`、`removeDataUsageEntry`。
5. `updateFromWsMsg` 的重启检测分支改为只清图表：

```ts
if (
  currentUploadTotal < lastUploadTotal ||
  currentDownloadTotal < lastDownloadTotal
) {
  globalStore.clearChartHistory()
}
```

并删除其中对 `enableDataUsageTracking` / `updateDataUsage(activeConns)` 的调用块。

6. 端点切换 watcher 简化（不再有 connectionLastData）：

```ts
const endpointStore = useEndpointStore()
watch(
  () => endpointStore.selectedEndpoint,
  () => {
    lastUploadTotal = 0
    lastDownloadTotal = 0
  },
)
```

7. `return { ... }` 移除 `clearDataUsage`、`removeDataUsageEntry`，保留：`allConnections`、`activeConnections`、`closedConnections`、`latestConnectionMsg`、`paused`、`speedGroupByName`、`updateFromWsMsg`、`restructRawMsgToConnection`。

> 保留 `lastUploadTotal`/`lastDownloadTotal`（重启检测必需）、`mergeAllConnections`、`diffClosedConnections`、`cleanupInactiveConnections`、`restructRawMsgToConnection`、`speedGroupByName`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run stores/__tests__/connections.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add stores/connections.ts stores/__tests__/connections.spec.ts
git commit -m "refactor(connections): remove local IndexedDB data-usage tracking"
```

---

## Task 8: 移除 `enableDataUsageTracking` 配置 + i18n 清理与新增

**Files:**

- Modify: `stores/config.ts`
- Modify: `pages/config.vue`
- Modify: `i18n/locales/en.json`, `i18n/locales/zh.json`, `i18n/locales/ru.json`

- [ ] **Step 1: `stores/config.ts`**

删除三处：

- 定义块（含注释）：`const enableDataUsageTracking = useLocalStorage('enableDataUsageTracking', true)`。
- `resetXdConfig` 内 `enableDataUsageTracking.value = true`。
- `return` 内 `enableDataUsageTracking,`（保留 `enableBackgroundCollector` / `collectorURL` / `collectorToken`）。

- [ ] **Step 2: `pages/config.vue`**

删除 `t('enableDataUsageTracking')` 那一整个 `<div class="flex items-center justify-between ...">` 开关块（含 `v-model="configStore.enableDataUsageTracking"` 的 input）。保留其后的 `enableBackgroundCollector` 开关块与采集器配置块。

- [ ] **Step 3: i18n — 删除废弃 key、新增空状态 key（三语言）**

在 `en.json` / `zh.json` / `ru.json` 中**删除** key：`enableDataUsageTracking`、`enableDataUsageTrackingDesc`、`dataRetention`、`collectorManagesRetention`。保留 `forever` / `lastHour` / `lastDay` / `lastMonth`（timeRange 共用）。

**新增** key（放在各文件 collector 相关 key 附近）：

en.json：

```json
  "collectorNotConfigured": "Collector not configured",
  "collectorNotConfiguredDesc": "Enable and configure the background collector in Settings to view traffic usage.",
  "goToSettings": "Go to Settings",
```

zh.json：

```json
  "collectorNotConfigured": "采集器未配置",
  "collectorNotConfiguredDesc": "请在设置中启用并配置后台采集器以查看流量用量。",
  "goToSettings": "前往设置",
```

ru.json：

```json
  "collectorNotConfigured": "Сборщик не настроен",
  "collectorNotConfiguredDesc": "Включите и настройте фоновый сборщик в настройках, чтобы видеть использование трафика.",
  "goToSettings": "Перейти к настройкам",
```

> 确认 JSON 逗号/结尾合法（删除/新增后无尾逗号错误）。

- [ ] **Step 4: 类型检查 + 单测**

Run: `pnpm typecheck && pnpm vitest run stores/__tests__/configCollector.spec.ts`
Expected: 无错误；configCollector 单测 PASS（该测试不引用 `enableDataUsageTracking`，无需改动）

- [ ] **Step 5: 提交**

```bash
git add stores/config.ts pages/config.vue i18n/locales/en.json i18n/locales/zh.json i18n/locales/ru.json
git commit -m "refactor(config): drop enableDataUsageTracking, add collector empty-state i18n"
```

---

## Task 9: 删除 `utils/db.ts`

**Files:**

- Delete: `utils/db.ts`

- [ ] **Step 1: 确认无引用**

Run: `grep -rnE "utils/db|DataUsageDB|from '~/utils/db'" --include="*.ts" --include="*.vue" . | grep -v node_modules | grep -v ".nuxt/"`
Expected: 仅 `collector/types.ts` 注释提及（注释，不算 import）。若有真实 import，回到对应 Task 修复。

- [ ] **Step 2: 删除文件**

```bash
git rm utils/db.ts
```

- [ ] **Step 3: 更新 `collector/types.ts` 注释**

把 `// Mirrors DataUsageLog in ~/utils/db.ts ...` 注释改为不再引用已删文件，例如：

```ts
// DataUsageLog is the collector's own row shape for stored connection deltas.
```

- [ ] **Step 4: 类型检查（两端）**

Run: `pnpm typecheck && pnpm typecheck:collector`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add utils/db.ts collector/types.ts
git commit -m "chore: remove unused local IndexedDB data-usage store"
```

---

## Task 10: 全量验证 + 孤儿审计 + 手动冒烟

**Files:** 无（验证任务）

- [ ] **Step 1: 全量单测**

Run: `pnpm test:unit`
Expected: 全部 PASS

- [ ] **Step 2: 两端类型检查**

Run: `pnpm typecheck && pnpm typecheck:collector`
Expected: 无错误

- [ ] **Step 3: 孤儿审计**

Run: `grep -rnE "removeDataUsageEntry|clearDataUsage|enableDataUsageTracking|selectedDataRetention|getHostDetailStats|source\.query" --include="*.ts" --include="*.vue" . | grep -v node_modules | grep -v ".nuxt/"`
Expected: 无结果（全部已清理）

- [ ] **Step 4: lint/format**

Run: `pnpm lint`
Expected: 无未修复错误

- [ ] **Step 5: 手动冒烟（采集器 + 仪表盘）**

1. 启动采集器：`pnpm collector`（确认监听 :9797）。
2. `pnpm dev`，设置里启用并配置采集器（URL+Token），确认健康探针 ok。
3. 流量页切到"最近一月"：确认**快速返回**、排名/趋势图/下钻完整显示。
4. 关闭采集器配置：确认流量页显示**空状态 + 去设置**。

- [ ] **Step 6: 提交（如有 lint/format 改动）**

```bash
git add -A
git commit -m "chore: lint and final cleanup for server-side aggregation"
```

---

## Self-Review 摘要

- **Spec 覆盖**：服务端聚合（Task 1-2）、前端契约/源/包装（Task 3-5）、空状态+保留期移除（Task 6）、本地子系统移除（Task 7-9）、展示完整=无 LIMIT（Task 1 SQL + Task 10 冒烟）。✓
- **类型一致**：`AggregateQuery`/`AggregateRow`/`GroupBy`/`Dimension` 在 collector（`collector/types.ts`）与前端（`~/types`）各自定义、形状一致；`store.aggregate` 签名、`source.aggregate` 签名、`useDataUsage` 包装贯穿一致。✓
- **占位符**：每个改动步骤均含完整代码/命令。✓
- **过渡期 typecheck**：Task 4 后前端 typecheck 暂红，Task 5 后转绿（已在 Task 4 Step 3 注明）。
