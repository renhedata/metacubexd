# Background Traffic Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone Node collector daemon that records per-connection mihomo traffic to SQLite 24/7, plus a Settings toggle so the Data Usage page reads from it — making stats survive a full browser quit.

**Architecture:** A new `collector/` daemon holds mihomo's `/connections` WebSocket open continuously, diffs per-connection upload/download (pure `tracker.ts`), buffers and flushes to `node:sqlite` (`store.ts`), and serves an authenticated HTTP read API (`server.ts`). The frontend gains a thin `useDataUsageSource` selector so the existing Data Usage page reads from either IndexedDB (local) or the collector (HTTP), chosen by three new settings.

**Tech Stack:** TypeScript run via `tsx` (already a dependency), Node 24 built-in `node:sqlite`, Node built-in `node:http` + global `WebSocket`, Vue 3 / Nuxt 4 / Pinia frontend, Vitest, Zod (response validation).

**Reference spec:** `docs/superpowers/specs/2026-06-09-background-traffic-collector-design.md`

---

## File Structure

**Collector (new `collector/` dir):**
- `collector/types.ts` — shared types (`DataUsageLog`, `RawConnection`, `ConnectionsMessage`).
- `collector/config.ts` — `loadConfig()` + `toWsURL()`.
- `collector/store.ts` — `createStore()` over `node:sqlite`.
- `collector/tracker.ts` — pure per-connection diff + buffer.
- `collector/mihomo.ts` — reconnecting `/connections` WebSocket client.
- `collector/server.ts` — HTTP read API (`/api/logs`, `/api/health`).
- `collector/index.ts` — wiring + lifecycle.
- `collector/tsconfig.json` — isolated typecheck for the daemon.
- `collector/__tests__/*.spec.ts` — unit tests.

**Frontend (modified + new):**
- `composables/useDataUsageSource.ts` — NEW source selector.
- `composables/__tests__/useDataUsageSource.spec.ts` — NEW test.
- `composables/useDataUsage.ts` — MODIFY (swap `db.query` → `source.query`).
- `stores/config.ts` — MODIFY (3 new settings + reset).
- `pages/config.vue` — MODIFY (settings UI).
- `pages/traffic.vue` — MODIFY (clear routing + retention disable).
- `i18n/locales/{en,zh,ru}.json` — MODIFY (new keys).
- `package.json` — MODIFY (scripts).
- `vitest.config.ts` — MODIFY (coverage include).

---

## Task 1: Collector shared types

**Files:**
- Create: `collector/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// collector/types.ts

// Mirrors DataUsageLog in ~/utils/db.ts so the HTTP API is shape-compatible
// with what the frontend's useDataUsage aggregation expects.
export interface DataUsageLog {
  id?: number
  timestamp: number
  sourceIP: string
  host: string
  outbound: string
  process: string
  inboundUser: string
  upload: number
  download: number
}

export interface RawConnectionMetadata {
  host?: string
  destinationIP?: string
  sourceIP?: string
  process?: string
  inboundUser?: string
  inboundIP?: string
  inboundName?: string
  type?: string
}

export interface RawConnection {
  id: string
  upload: number
  download: number
  chains: string[]
  metadata: RawConnectionMetadata
}

export interface ConnectionsMessage {
  connections?: RawConnection[]
  uploadTotal?: number
  downloadTotal?: number
}
```

- [ ] **Step 2: Commit**

```bash
git add collector/types.ts
git commit -m "feat(collector): add shared types"
```

---

## Task 2: SQLite store

**Files:**
- Create: `collector/store.ts`
- Test: `collector/__tests__/store.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// collector/__tests__/store.spec.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../store'
import type { DataUsageLog } from '../types'

const makeLog = (over: Partial<DataUsageLog> = {}): DataUsageLog => ({
  timestamp: 60000,
  sourceIP: '10.0.0.1',
  host: 'example.com',
  outbound: 'PROXY',
  process: 'curl',
  inboundUser: 'Unknown',
  upload: 100,
  download: 200,
  ...over,
})

describe('collector/store', () => {
  let store: Store

  beforeEach(() => {
    store = createStore(':memory:')
  })

  it('inserts and queries logs within a time range', () => {
    store.insertLogs([
      makeLog({ timestamp: 60000 }),
      makeLog({ timestamp: 120000, host: 'other.com' }),
      makeLog({ timestamp: 999999999, host: 'future.com' }),
    ])

    const rows = store.query(0, 200000)

    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.host)).toEqual(['example.com', 'other.com'])
    expect(rows[0]!.upload).toBe(100)
  })

  it('cleanup deletes rows older than the cutoff', () => {
    store.insertLogs([
      makeLog({ timestamp: 1000 }),
      makeLog({ timestamp: 5000 }),
    ])

    store.cleanup(3000)

    expect(store.count()).toBe(1)
    expect(store.query(0, 10000)[0]!.timestamp).toBe(5000)
  })

  it('clearAll removes everything', () => {
    store.insertLogs([makeLog(), makeLog()])
    store.clearAll()
    expect(store.count()).toBe(0)
  })

  it('insertLogs is a no-op for an empty array', () => {
    store.insertLogs([])
    expect(store.count()).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run collector/__tests__/store.spec.ts`
Expected: FAIL — cannot find module `../store`.

- [ ] **Step 3: Write the implementation**

```ts
// collector/store.ts
import { DatabaseSync } from 'node:sqlite'
import type { DataUsageLog } from './types'

export interface Store {
  insertLogs: (logs: DataUsageLog[]) => void
  query: (start: number, end: number) => DataUsageLog[]
  cleanup: (before: number) => void
  clearAll: () => void
  count: () => number
  close: () => void
}

export function createStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS data_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      sourceIP TEXT NOT NULL,
      host TEXT NOT NULL,
      outbound TEXT NOT NULL,
      process TEXT NOT NULL,
      inboundUser TEXT NOT NULL,
      upload INTEGER NOT NULL,
      download INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON data_usage_logs (timestamp);
  `)

  const insertStmt = db.prepare(
    `INSERT INTO data_usage_logs
       (timestamp, sourceIP, host, outbound, process, inboundUser, upload, download)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const queryStmt = db.prepare(
    `SELECT id, timestamp, sourceIP, host, outbound, process, inboundUser, upload, download
       FROM data_usage_logs
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC`,
  )
  const cleanupStmt = db.prepare('DELETE FROM data_usage_logs WHERE timestamp < ?')
  const clearStmt = db.prepare('DELETE FROM data_usage_logs')
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM data_usage_logs')

  return {
    insertLogs(logs) {
      if (logs.length === 0) return
      db.exec('BEGIN')
      try {
        for (const l of logs) {
          insertStmt.run(
            l.timestamp,
            l.sourceIP,
            l.host,
            l.outbound,
            l.process,
            l.inboundUser,
            l.upload,
            l.download,
          )
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    query(start, end) {
      return queryStmt.all(start, end) as unknown as DataUsageLog[]
    },
    cleanup(before) {
      cleanupStmt.run(before)
    },
    clearAll() {
      clearStmt.run()
    },
    count() {
      const row = countStmt.get() as { n: number }
      return row.n
    },
    close() {
      db.close()
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run collector/__tests__/store.spec.ts`
Expected: PASS (4 tests). A Node `ExperimentalWarning` for `node:sqlite` is expected and harmless.

- [ ] **Step 5: Commit**

```bash
git add collector/store.ts collector/__tests__/store.spec.ts
git commit -m "feat(collector): add node:sqlite store"
```

---

## Task 3: Tracker (pure per-connection diff)

**Files:**
- Create: `collector/tracker.ts`
- Test: `collector/__tests__/tracker.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// collector/__tests__/tracker.spec.ts
import { describe, expect, it } from 'vitest'
import { createTracker } from '../tracker'
import type { ConnectionsMessage, RawConnection } from '../types'

const conn = (over: Partial<RawConnection> = {}): RawConnection => ({
  id: 'c1',
  upload: 0,
  download: 0,
  chains: ['PROXY'],
  metadata: {
    sourceIP: '10.0.0.1',
    host: 'example.com',
    process: 'curl',
    inboundUser: 'user1',
  },
  ...over,
})

const msg = (
  connections: RawConnection[],
  uploadTotal = 0,
  downloadTotal = 0,
): ConnectionsMessage => ({ connections, uploadTotal, downloadTotal })

describe('collector/tracker', () => {
  it('emits no delta on the first observation of a connection (baseline-only)', () => {
    const t = createTracker(() => 60000)
    t.processMessage(msg([conn({ upload: 500, download: 900 })], 500, 900))
    expect(t.drainBuffer()).toEqual([])
  })

  it('emits the delta from the second observation onward', () => {
    const t = createTracker(() => 60000)
    t.processMessage(msg([conn({ upload: 500, download: 900 })], 500, 900))
    t.processMessage(msg([conn({ upload: 700, download: 1500 })], 700, 1500))

    const logs = t.drainBuffer()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      timestamp: 60000,
      sourceIP: '10.0.0.1',
      host: 'example.com',
      outbound: 'PROXY',
      process: 'curl',
      inboundUser: 'user1',
      upload: 200,
      download: 600,
    })
  })

  it('aggregates deltas within the same minute bucket by composite key', () => {
    let now = 60000
    const t = createTracker(() => now)
    t.processMessage(msg([conn({ upload: 0, download: 0 })]))
    t.processMessage(msg([conn({ upload: 100, download: 100 })]))
    t.processMessage(msg([conn({ upload: 250, download: 100 })]))

    const logs = t.drainBuffer()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ upload: 250, download: 100 })
  })

  it('resets per-connection baseline on core restart but keeps no record of it', () => {
    const t = createTracker(() => 60000)
    // Establish baseline + one delta.
    t.processMessage(msg([conn({ upload: 100, download: 100 })], 100, 100))
    t.processMessage(msg([conn({ upload: 300, download: 300 })], 300, 300))
    t.drainBuffer()

    // Core restarts: totals drop. Same connection id now reports low cumulative.
    t.processMessage(msg([conn({ upload: 50, download: 50 })], 50, 50))
    // First post-restart sample is baseline-only -> no delta.
    expect(t.drainBuffer()).toEqual([])

    // Next sample emits the delta from the new baseline (not 50 -> would be
    // negative; clamps to a real delta from 50).
    t.processMessage(msg([conn({ upload: 120, download: 90 })], 120, 90))
    expect(t.drainBuffer()[0]).toMatchObject({ upload: 70, download: 40 })
  })

  it('clamps negative deltas to zero', () => {
    const t = createTracker(() => 60000)
    t.processMessage(msg([conn({ upload: 100, download: 100 })], 100, 100))
    // Same totals (no restart), but this connection's counter went backwards.
    t.processMessage(msg([conn({ upload: 80, download: 130 })], 100, 100))
    const logs = t.drainBuffer()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ upload: 0, download: 30 })
  })

  it('falls back through metadata fields for label values', () => {
    const t = createTracker(() => 60000)
    const bare = conn({
      id: 'c2',
      chains: [],
      metadata: { destinationIP: '1.2.3.4', type: 'TCP' },
    })
    t.processMessage(msg([{ ...bare, upload: 0, download: 0 }]))
    t.processMessage(msg([{ ...bare, upload: 10, download: 0 }]))
    const logs = t.drainBuffer()
    expect(logs[0]).toMatchObject({
      sourceIP: 'Inner',
      host: '1.2.3.4',
      process: 'Unknown',
      outbound: 'DIRECT',
      inboundUser: 'TCP',
    })
  })

  it('drainBuffer empties the buffer', () => {
    const t = createTracker(() => 60000)
    t.processMessage(msg([conn({ upload: 0, download: 0 })]))
    t.processMessage(msg([conn({ upload: 10, download: 10 })]))
    expect(t.drainBuffer()).toHaveLength(1)
    expect(t.drainBuffer()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run collector/__tests__/tracker.spec.ts`
Expected: FAIL — cannot find module `../tracker`.

- [ ] **Step 3: Write the implementation**

```ts
// collector/tracker.ts
import type { ConnectionsMessage, DataUsageLog } from './types'

export interface Tracker {
  processMessage: (msg: ConnectionsMessage) => void
  drainBuffer: () => DataUsageLog[]
  hasBuffered: () => boolean
}

// \x1F (unit separator) cannot appear in hosts, IPs or process names, so it is
// a safe delimiter for the composite aggregation key (mirrors stores/connections.ts).
const bufferKey = (l: DataUsageLog): string =>
  `${l.timestamp}\x1F${l.sourceIP}\x1F${l.host}\x1F${l.outbound}\x1F${l.process}\x1F${l.inboundUser}`

export function createTracker(now: () => number = Date.now): Tracker {
  const lastData = new Map<string, { upload: number; download: number }>()
  const buffer = new Map<string, DataUsageLog>()
  let lastUploadTotal = 0
  let lastDownloadTotal = 0

  const processMessage = (msg: ConnectionsMessage): void => {
    const up = msg.uploadTotal ?? 0
    const down = msg.downloadTotal ?? 0

    // Core restart: cumulative totals went backwards. Reset the per-connection
    // baseline only — persisted history is intentionally preserved (collector
    // differs from the in-browser tracker here).
    if (up < lastUploadTotal || down < lastDownloadTotal) {
      lastData.clear()
    }
    lastUploadTotal = up
    lastDownloadTotal = down

    const conns = msg.connections
    if (!conns || conns.length === 0) return

    const minuteStart = Math.floor(now() / 60000) * 60000
    const seen = new Set<string>()

    for (const conn of conns) {
      seen.add(conn.id)
      const curUp = conn.upload || 0
      const curDown = conn.download || 0
      const prev = lastData.get(conn.id)
      lastData.set(conn.id, { upload: curUp, download: curDown })

      // Baseline-only on first observation: emit nothing (collector differs
      // from the in-browser tracker, which counts the full cumulative here).
      if (!prev) continue

      const upDelta = Math.max(0, curUp - prev.upload)
      const downDelta = Math.max(0, curDown - prev.download)
      if (upDelta === 0 && downDelta === 0) continue

      const log: DataUsageLog = {
        timestamp: minuteStart,
        sourceIP: conn.metadata.sourceIP || 'Inner',
        host: conn.metadata.host || conn.metadata.destinationIP || '',
        process: conn.metadata.process || 'Unknown',
        outbound: conn.chains[0] ?? 'DIRECT',
        inboundUser:
          conn.metadata.inboundUser ||
          conn.metadata.inboundIP ||
          conn.metadata.inboundName ||
          conn.metadata.type ||
          'Unknown',
        upload: upDelta,
        download: downDelta,
      }

      const key = bufferKey(log)
      const existing = buffer.get(key)
      if (existing) {
        existing.upload += upDelta
        existing.download += downDelta
      } else {
        buffer.set(key, log)
      }
    }

    // Drop tracking state for connections no longer active.
    for (const id of lastData.keys()) {
      if (!seen.has(id)) lastData.delete(id)
    }
  }

  const drainBuffer = (): DataUsageLog[] => {
    const logs = Array.from(buffer.values())
    buffer.clear()
    return logs
  }

  return { processMessage, drainBuffer, hasBuffered: () => buffer.size > 0 }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run collector/__tests__/tracker.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add collector/tracker.ts collector/__tests__/tracker.spec.ts
git commit -m "feat(collector): add pure per-connection traffic tracker"
```

---

## Task 4: Config loader

**Files:**
- Create: `collector/config.ts`
- Test: `collector/__tests__/config.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// collector/__tests__/config.spec.ts
import { describe, expect, it } from 'vitest'
import { loadConfig, toWsURL } from '../config'

describe('collector/config', () => {
  it('toWsURL converts http to ws and https to wss, trimming trailing slash', () => {
    expect(toWsURL('http://127.0.0.1:9090/')).toBe('ws://127.0.0.1:9090')
    expect(toWsURL('https://host:9090')).toBe('wss://host:9090')
  })

  it('throws when MIHOMO_API_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/MIHOMO_API_URL is required/)
  })

  it('throws when MIHOMO_API_URL is not a valid URL', () => {
    expect(() => loadConfig({ MIHOMO_API_URL: 'not a url' })).toThrow(
      /not a valid URL/,
    )
  })

  it('applies defaults', () => {
    const cfg = loadConfig({ MIHOMO_API_URL: 'http://127.0.0.1:9090' })
    expect(cfg).toMatchObject({
      mihomoApiURL: 'http://127.0.0.1:9090',
      mihomoWsURL: 'ws://127.0.0.1:9090',
      mihomoSecret: '',
      port: 9797,
      dbPath: './collector-data.sqlite',
      retentionMs: 0,
      token: '',
      allowedOrigin: '*',
    })
  })

  it('reads overrides from env', () => {
    const cfg = loadConfig({
      MIHOMO_API_URL: 'http://h:1',
      MIHOMO_SECRET: 's',
      PORT: '8000',
      DB_PATH: '/data/x.sqlite',
      RETENTION_MS: '3600000',
      COLLECTOR_TOKEN: 'tok',
      ALLOWED_ORIGIN: 'https://app.example',
    })
    expect(cfg).toMatchObject({
      mihomoSecret: 's',
      port: 8000,
      dbPath: '/data/x.sqlite',
      retentionMs: 3600000,
      token: 'tok',
      allowedOrigin: 'https://app.example',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run collector/__tests__/config.spec.ts`
Expected: FAIL — cannot find module `../config`.

- [ ] **Step 3: Write the implementation**

```ts
// collector/config.ts
export interface CollectorConfig {
  mihomoApiURL: string
  mihomoWsURL: string
  mihomoSecret: string
  port: number
  dbPath: string
  retentionMs: number
  token: string
  allowedOrigin: string
}

export function toWsURL(httpURL: string): string {
  return new URL(httpURL).href.replace(/^http/, 'ws').replace(/\/$/, '')
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): CollectorConfig {
  const mihomoApiURL = env.MIHOMO_API_URL
  if (!mihomoApiURL) {
    throw new Error('MIHOMO_API_URL is required')
  }

  let mihomoWsURL: string
  try {
    mihomoWsURL = toWsURL(mihomoApiURL)
  } catch {
    throw new Error(`MIHOMO_API_URL is not a valid URL: ${mihomoApiURL}`)
  }

  return {
    mihomoApiURL,
    mihomoWsURL,
    mihomoSecret: env.MIHOMO_SECRET ?? '',
    port: Number(env.PORT ?? 9797),
    dbPath: env.DB_PATH ?? './collector-data.sqlite',
    retentionMs: Number(env.RETENTION_MS ?? 0),
    token: env.COLLECTOR_TOKEN ?? '',
    allowedOrigin: env.ALLOWED_ORIGIN ?? '*',
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run collector/__tests__/config.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add collector/config.ts collector/__tests__/config.spec.ts
git commit -m "feat(collector): add env config loader"
```

---

## Task 5: Reconnecting mihomo WebSocket client

**Files:**
- Create: `collector/mihomo.ts`
- Test: `collector/__tests__/mihomo.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// collector/__tests__/mihomo.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectMihomo } from '../mihomo'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  close = vi.fn()
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
}

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('collector/mihomo', () => {
  it('connects to /connections with the secret as a token query param', () => {
    connectMihomo({ wsURL: 'ws://h:9090', secret: 'abc', onMessage: () => {} })
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]!.url).toBe(
      'ws://h:9090/connections?token=abc',
    )
  })

  it('parses incoming JSON and forwards it to onMessage', () => {
    const onMessage = vi.fn()
    connectMihomo({ wsURL: 'ws://h:9090', secret: '', onMessage })
    MockWebSocket.instances[0]!.onmessage!({ data: '{"uploadTotal":5}' })
    expect(onMessage).toHaveBeenCalledWith({ uploadTotal: 5 })
  })

  it('ignores malformed JSON without throwing', () => {
    const onMessage = vi.fn()
    connectMihomo({ wsURL: 'ws://h:9090', secret: '', onMessage })
    expect(() =>
      MockWebSocket.instances[0]!.onmessage!({ data: 'not json' }),
    ).not.toThrow()
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('reconnects after an unexpected close', async () => {
    vi.useFakeTimers()
    connectMihomo({ wsURL: 'ws://h:9090', secret: '', onMessage: () => {} })
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]!.onclose!({})
    await vi.advanceTimersByTimeAsync(4000)

    expect(MockWebSocket.instances).toHaveLength(2)
    vi.useRealTimers()
  })

  it('does not reconnect after close() is called', async () => {
    vi.useFakeTimers()
    const client = connectMihomo({
      wsURL: 'ws://h:9090',
      secret: '',
      onMessage: () => {},
    })
    const first = MockWebSocket.instances[0]!

    client.close()
    first.onclose?.({})
    await vi.advanceTimersByTimeAsync(4000)

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(first.close).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run collector/__tests__/mihomo.spec.ts`
Expected: FAIL — cannot find module `../mihomo`.

- [ ] **Step 3: Write the implementation**

```ts
// collector/mihomo.ts
const RECONNECT_DELAY = 3000

export interface MihomoClientOptions {
  wsURL: string
  secret: string
  onMessage: (msg: unknown) => void
  log?: (msg: string) => void
}

export interface MihomoClient {
  close: () => void
}

export function connectMihomo(opts: MihomoClientOptions): MihomoClient {
  const log = opts.log ?? (() => {})
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const buildURL = (): string => {
    const params = new URLSearchParams()
    if (opts.secret) params.set('token', opts.secret)
    return `${opts.wsURL}/connections?${params.toString()}`
  }

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open()
    }, RECONNECT_DELAY)
  }

  const open = (): void => {
    if (closed) return
    ws = new WebSocket(buildURL())
    ws.onmessage = (event: MessageEvent) => {
      try {
        opts.onMessage(JSON.parse(event.data as string))
      } catch {
        // ignore parse errors
      }
    }
    ws.onerror = () => log('mihomo websocket error')
    ws.onclose = () => {
      if (closed) return
      log('mihomo websocket closed, reconnecting')
      scheduleReconnect()
    }
  }

  open()

  return {
    close() {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        ws.onclose = null
        ws.close()
        ws = null
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run collector/__tests__/mihomo.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add collector/mihomo.ts collector/__tests__/mihomo.spec.ts
git commit -m "feat(collector): add reconnecting mihomo websocket client"
```

---

## Task 6: HTTP read API server

**Files:**
- Create: `collector/server.ts`
- Test: `collector/__tests__/server.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// collector/__tests__/server.spec.ts
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from '../server'
import { createStore, type Store } from '../store'
import type { DataUsageLog } from '../types'

const makeLog = (over: Partial<DataUsageLog> = {}): DataUsageLog => ({
  timestamp: 60000,
  sourceIP: '10.0.0.1',
  host: 'example.com',
  outbound: 'PROXY',
  process: 'curl',
  inboundUser: 'Unknown',
  upload: 100,
  download: 200,
  ...over,
})

describe('collector/server', () => {
  let store: Store
  let server: Server
  let base: string

  const start = async (token = ''): Promise<void> => {
    server = createServer({
      store,
      token,
      allowedOrigin: '*',
      startedAt: 1000,
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}`
  }

  beforeEach(() => {
    store = createStore(':memory:')
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
  })

  it('GET /api/health returns ok with row count (no auth required)', async () => {
    store.insertLogs([makeLog()])
    await start('secret')
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, since: 1000, count: 1 })
  })

  it('GET /api/logs returns rows in range with CORS header', async () => {
    store.insertLogs([makeLog({ host: 'a.com' }), makeLog({ host: 'b.com' })])
    await start()
    const res = await fetch(`${base}/api/logs?start=0&end=100000`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const rows = (await res.json()) as DataUsageLog[]
    expect(rows.map((r) => r.host)).toEqual(['a.com', 'b.com'])
  })

  it('rejects /api/logs without a valid bearer token', async () => {
    await start('secret')
    const res = await fetch(`${base}/api/logs?start=0&end=1`)
    expect(res.status).toBe(401)
  })

  it('accepts /api/logs with the correct bearer token', async () => {
    await start('secret')
    const res = await fetch(`${base}/api/logs?start=0&end=1`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
  })

  it('DELETE /api/logs clears the store', async () => {
    store.insertLogs([makeLog()])
    await start()
    const res = await fetch(`${base}/api/logs`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(store.count()).toBe(0)
  })

  it('returns 404 for unknown routes', async () => {
    await start()
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run collector/__tests__/server.spec.ts`
Expected: FAIL — cannot find module `../server`.

- [ ] **Step 3: Write the implementation**

```ts
// collector/server.ts
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Store } from './store'

export interface ServerOptions {
  store: Store
  token: string
  allowedOrigin: string
  startedAt: number
}

export function createServer(opts: ServerOptions): Server {
  const { store, token, allowedOrigin, startedAt } = opts

  const setCors = (res: ServerResponse): void => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  }

  const isAuthorized = (req: IncomingMessage): boolean => {
    if (!token) return true
    return (req.headers.authorization ?? '') === `Bearer ${token}`
  }

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  return createHttpServer((req, res) => {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')

    // Health is public so the dashboard can probe reachability without a token.
    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, { ok: true, since: startedAt, count: store.count() })
      return
    }

    if (!isAuthorized(req)) {
      json(res, 401, { error: 'unauthorized' })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const start = Number(url.searchParams.get('start') ?? 0)
      const end = Number(url.searchParams.get('end') ?? Date.now())
      json(res, 200, store.query(start, end))
      return
    }

    if (req.method === 'DELETE' && url.pathname === '/api/logs') {
      store.clearAll()
      json(res, 200, { ok: true })
      return
    }

    json(res, 404, { error: 'not found' })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run collector/__tests__/server.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add collector/server.ts collector/__tests__/server.spec.ts
git commit -m "feat(collector): add http read api server"
```

---

## Task 7: Daemon entrypoint + tsconfig + scripts

**Files:**
- Create: `collector/index.ts`
- Create: `collector/tsconfig.json`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the entrypoint**

```ts
// collector/index.ts
import { connectMihomo } from './mihomo'
import { createServer } from './server'
import { createStore } from './store'
import { createTracker } from './tracker'
import { loadConfig } from './config'
import type { ConnectionsMessage } from './types'

const FLUSH_INTERVAL_MS = 30000

function main(): void {
  const config = loadConfig()
  const store = createStore(config.dbPath)
  const tracker = createTracker()
  const startedAt = Date.now()

  const client = connectMihomo({
    wsURL: config.mihomoWsURL,
    secret: config.mihomoSecret,
    onMessage: (msg) => tracker.processMessage(msg as ConnectionsMessage),
    log: (m) => console.log(`[collector] ${m}`),
  })

  const flush = (): void => {
    const logs = tracker.drainBuffer()
    if (logs.length === 0) return
    store.insertLogs(logs)
    if (config.retentionMs > 0) {
      store.cleanup(Date.now() - config.retentionMs)
    }
  }

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)

  const server = createServer({
    store,
    token: config.token,
    allowedOrigin: config.allowedOrigin,
    startedAt,
  })
  server.listen(config.port, () => {
    console.log(
      `[collector] listening on :${config.port} db=${config.dbPath} mihomo=${config.mihomoWsURL}`,
    )
  })

  const shutdown = (): void => {
    clearInterval(flushTimer)
    flush()
    client.close()
    server.close()
    store.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
```

- [ ] **Step 2: Create the collector tsconfig (isolated typecheck)**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 3: Add scripts to `package.json`**

In the `"scripts"` block (`package.json:7-24`), add these two entries (keep alphabetical-ish; place `collector` after `build:mock` and `typecheck:collector` after `typecheck`):

```jsonc
"collector": "tsx collector/index.ts",
```
```jsonc
"typecheck:collector": "tsc -p collector/tsconfig.json",
```

Resulting `scripts` block for reference:

```json
  "scripts": {
    "build": "nuxt build",
    "build:mock": "MOCK_MODE=true nuxt build",
    "collector": "tsx collector/index.ts",
    "dev": "nuxt dev --host",
    "dev:mock": "MOCK_MODE=true nuxt dev --host",
    "format": "pnpm prettier --write --ignore-unknown .",
    "generate": "nuxt generate",
    "generate:mock": "MOCK_MODE=true nuxt generate",
    "postinstall": "nuxt prepare",
    "lint": "eslint --fix .",
    "prepare": "nuxt prepare && husky",
    "preview": "nuxt preview --host",
    "screenshot": "tsx scripts/screenshot.ts",
    "test:e2e": "vitest run e2e/",
    "test:unit": "vitest run --exclude='e2e/**'",
    "test:coverage": "vitest run --coverage --exclude='e2e/**'",
    "typecheck": "vue-tsc --noEmit",
    "typecheck:collector": "tsc -p collector/tsconfig.json"
  },
```

- [ ] **Step 4: Typecheck the collector**

Run: `pnpm typecheck:collector`
Expected: no errors. (If `tsc` reports that a `.ts` import needs an extension, confirm imports are extensionless as written above.)

- [ ] **Step 5: Smoke-test the daemon boots and serves health**

Run (no mihomo needed to verify the server comes up; the WS client will just retry):
```bash
MIHOMO_API_URL=http://127.0.0.1:9090 PORT=9797 DB_PATH=./.tmp-collector.sqlite pnpm collector &
sleep 1
curl -s http://127.0.0.1:9797/api/health
kill %1
rm -f ./.tmp-collector.sqlite
```
Expected: a JSON line like `{"ok":true,"since":<ms>,"count":0}`.

- [ ] **Step 6: Commit**

```bash
git add collector/index.ts collector/tsconfig.json package.json
git commit -m "feat(collector): add daemon entrypoint, tsconfig and scripts"
```

---

## Task 8: Add collector to vitest coverage include

**Files:**
- Modify: `vitest.config.ts:27`

- [ ] **Step 1: Extend the coverage include array**

Change line 27 from:
```ts
      include: ['stores/**/*.ts', 'composables/**/*.ts', 'utils/**/*.ts'],
```
to:
```ts
      include: [
        'stores/**/*.ts',
        'composables/**/*.ts',
        'utils/**/*.ts',
        'collector/**/*.ts',
      ],
```

- [ ] **Step 2: Verify all collector tests still run**

Run: `pnpm vitest run collector/`
Expected: PASS (all suites from Tasks 2–6).

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "test(collector): include collector in coverage"
```

---

## Task 9: Frontend config settings

**Files:**
- Modify: `stores/config.ts`
- Test: `stores/__tests__/configCollector.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// stores/__tests__/configCollector.spec.ts
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useConfigStore } from '../config'

describe('stores/config — background collector settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('defaults collector settings to off/empty', () => {
    const store = useConfigStore()
    expect(store.enableBackgroundCollector).toBe(false)
    expect(store.collectorURL).toBe('')
    expect(store.collectorToken).toBe('')
  })

  it('resetXdConfig turns the collector back off', () => {
    const store = useConfigStore()
    store.enableBackgroundCollector = true
    store.collectorURL = 'http://localhost:9797'
    store.resetXdConfig()
    expect(store.enableBackgroundCollector).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run stores/__tests__/configCollector.spec.ts`
Expected: FAIL — `enableBackgroundCollector` is undefined.

- [ ] **Step 3: Add the settings to the store**

In `stores/config.ts`, immediately after the `enableDataUsageTracking` block (ends at line 167), insert:

```ts
  // Background collector. When enabled, the Data Usage page reads historical
  // stats from a standalone collector daemon (over HTTP) instead of IndexedDB.
  // The daemon runs independently of the browser, so stats keep accruing even
  // when the browser is fully closed. See collector/ and the design spec.
  const enableBackgroundCollector = useLocalStorage(
    'enableBackgroundCollector',
    false,
  )
  const collectorURL = useLocalStorage('collectorURL', '')
  const collectorToken = useLocalStorage('collectorToken', '')
```

In `resetXdConfig` (after `enableDataUsageTracking.value = true` at line 230), add:

```ts
    enableBackgroundCollector.value = false
    collectorURL.value = ''
    collectorToken.value = ''
```

In the returned object, after `enableDataUsageTracking,` (line 280), add:

```ts
    enableBackgroundCollector,
    collectorURL,
    collectorToken,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run stores/__tests__/configCollector.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add stores/config.ts stores/__tests__/configCollector.spec.ts
git commit -m "feat(config): add background collector settings"
```

---

## Task 10: Data-usage source selector

**Files:**
- Create: `composables/useDataUsageSource.ts`
- Test: `composables/__tests__/useDataUsageSource.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// composables/__tests__/useDataUsageSource.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDataUsageSource } from '../useDataUsageSource'

const dbQuery = vi.fn()
const dbClearAll = vi.fn()

vi.mock('~/utils/db', () => ({
  db: {
    query: (...args: unknown[]) => dbQuery(...args),
    clearAll: (...args: unknown[]) => dbClearAll(...args),
  },
}))

const configStore = {
  enableBackgroundCollector: false,
  collectorURL: 'http://collector:9797',
  collectorToken: 'tok',
}

vi.stubGlobal('useConfigStore', () => configStore)

beforeEach(() => {
  vi.clearAllMocks()
  configStore.enableBackgroundCollector = false
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('useConfigStore', () => configStore)
})

describe('composables/useDataUsageSource', () => {
  it('queries IndexedDB when the collector is disabled', async () => {
    dbQuery.mockResolvedValue([{ host: 'local' }])
    const { query } = useDataUsageSource()

    const rows = await query(0, 100)

    expect(dbQuery).toHaveBeenCalledWith(0, 100)
    expect(rows).toEqual([{ host: 'local' }])
  })

  it('queries the collector over HTTP when enabled', async () => {
    configStore.enableBackgroundCollector = true
    const row = {
      timestamp: 60000,
      sourceIP: '10.0.0.1',
      host: 'remote',
      outbound: 'PROXY',
      process: 'curl',
      inboundUser: 'Unknown',
      upload: 1,
      download: 2,
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [row],
    })
    vi.stubGlobal('fetch', fetchMock)

    const { query } = useDataUsageSource()
    const rows = await query(10, 20)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://collector:9797/api/logs?start=10&end=20',
      { headers: { Authorization: 'Bearer tok' } },
    )
    expect(rows).toEqual([row])
  })

  it('throws when the collector responds non-ok', async () => {
    configStore.enableBackgroundCollector = true
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    )
    const { query } = useDataUsageSource()
    await expect(query(0, 1)).rejects.toThrow(/collector/i)
  })

  it('clearCollectorData issues a DELETE to the collector', async () => {
    configStore.enableBackgroundCollector = true
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const { clearCollectorData } = useDataUsageSource()
    await clearCollectorData()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://collector:9797/api/logs',
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run composables/__tests__/useDataUsageSource.spec.ts`
Expected: FAIL — cannot find module `../useDataUsageSource`.

- [ ] **Step 3: Write the implementation**

```ts
// composables/useDataUsageSource.ts
import type { DataUsageLog } from '~/utils/db'
import { z } from 'zod'
import { db } from '~/utils/db'

export interface DataUsageSource {
  query: (start: number, end: number) => Promise<DataUsageLog[]>
  clearCollectorData: () => Promise<void>
}

const dataUsageLogSchema = z.object({
  id: z.number().optional(),
  timestamp: z.number(),
  sourceIP: z.string(),
  host: z.string(),
  outbound: z.string(),
  process: z.string(),
  inboundUser: z.string(),
  upload: z.number(),
  download: z.number(),
})
const dataUsageLogsSchema = z.array(dataUsageLogSchema)

export function useDataUsageSource(): DataUsageSource {
  const configStore = useConfigStore()

  const authHeaders = (): Record<string, string> =>
    configStore.collectorToken
      ? { Authorization: `Bearer ${configStore.collectorToken}` }
      : {}

  const base = (): string => configStore.collectorURL.replace(/\/$/, '')

  const queryCollector = async (
    start: number,
    end: number,
  ): Promise<DataUsageLog[]> => {
    const res = await fetch(`${base()}/api/logs?start=${start}&end=${end}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      throw new Error(`Collector request failed with status ${res.status}`)
    }
    return dataUsageLogsSchema.parse(await res.json())
  }

  const query = (start: number, end: number): Promise<DataUsageLog[]> =>
    configStore.enableBackgroundCollector
      ? queryCollector(start, end)
      : db.query(start, end)

  const clearCollectorData = async (): Promise<void> => {
    const res = await fetch(`${base()}/api/logs`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (!res.ok) {
      throw new Error(`Collector clear failed with status ${res.status}`)
    }
  }

  return { query, clearCollectorData }
}
```

> Note: `useConfigStore` is a Nuxt auto-import in the app; the test stubs it as a global, mirroring `composables/__tests__/useWebSocket.spec.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run composables/__tests__/useDataUsageSource.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add composables/useDataUsageSource.ts composables/__tests__/useDataUsageSource.spec.ts
git commit -m "feat(data-usage): add IndexedDB/collector source selector"
```

---

## Task 11: Route Data Usage reads through the source selector

**Files:**
- Modify: `composables/useDataUsage.ts`

- [ ] **Step 1: Import the source and capture it once**

In `composables/useDataUsage.ts`, change the top of the file. Replace:

```ts
import type { DataUsageType } from '~/types'
import { db } from '~/utils/db'

export interface AggregatedData {
```
with:
```ts
import type { DataUsageType } from '~/types'
import { useDataUsageSource } from '~/composables/useDataUsageSource'

export interface AggregatedData {
```

Then, immediately inside `export const useDataUsage = () => {` (line 12), add as the first line of the body:

```ts
  const source = useDataUsageSource()
```

- [ ] **Step 2: Swap every `db.query(...)` to `source.query(...)`**

There are 7 occurrences inside `useDataUsage` (lines 18, 67, 112, 156, 188, 221, 252). Replace each:

```ts
const logs = await db.query(startTime, endTime)
```
with:
```ts
const logs = await source.query(startTime, endTime)
```

- [ ] **Step 3: Verify nothing else references `db` in this file**

Run: `grep -n "db\." composables/useDataUsage.ts`
Expected: no matches.

- [ ] **Step 4: Run the full unit suite to confirm no regressions**

Run: `pnpm test:unit`
Expected: PASS (all suites, including the new ones).

- [ ] **Step 5: Typecheck the frontend**

Run: `pnpm typecheck`
Expected: no errors related to `useDataUsage` / `useDataUsageSource`.

- [ ] **Step 6: Commit**

```bash
git add composables/useDataUsage.ts
git commit -m "refactor(data-usage): read via source selector"
```

---

## Task 12: Wire clear + retention in the Data Usage page

**Files:**
- Modify: `pages/traffic.vue`

- [ ] **Step 1: Import the source composable and wire it up**

In the `<script setup>` block, add an explicit import next to the existing
`import { useDataUsage } from '~/composables/useDataUsage'` (line 18):

```ts
import { useDataUsageSource } from '~/composables/useDataUsageSource'
```

Then, after the existing `useDataUsage()` destructure (ends at line 30), add:

```ts
const configStore = useConfigStore()
const { clearCollectorData } = useDataUsageSource()
```

> `useConfigStore` is a Pinia auto-import (this file already uses
> `useConnectionsStore()` without importing it), so no import is needed for it.

- [ ] **Step 2: Branch the clear handler by mode**

Replace `handleClearAll` (lines 193–198):

```ts
async function handleClearAll() {
  if (confirm(t('confirmClearAll'))) {
    await connectionsStore.clearDataUsage()
    await fetchData()
  }
}
```
with:
```ts
async function handleClearAll() {
  if (!confirm(t('confirmClearAll'))) return
  if (configStore.enableBackgroundCollector) {
    await clearCollectorData()
  } else {
    await connectionsStore.clearDataUsage()
  }
  await fetchData()
}
```

- [ ] **Step 3: Disable the local retention control in collector mode**

In the retention `<select>` (starts at line 340), add a `:disabled` binding and disabled styling. Change the opening tag:

```html
            <select
              v-model.number="selectedDataRetention"
              :title="t('dataRetention')"
```
to:
```html
            <select
              v-model.number="selectedDataRetention"
              :disabled="configStore.enableBackgroundCollector"
              :title="
                configStore.enableBackgroundCollector
                  ? t('collectorManagesRetention')
                  : t('dataRetention')
              "
```

And append `disabled:cursor-not-allowed disabled:opacity-40` to that `<select>`'s existing `class="..."` string (the long class on line 343).

- [ ] **Step 4: Verify the page typechecks**

Run: `pnpm typecheck`
Expected: no errors. (The `collectorManagesRetention` key is added in Task 13; if typecheck flags missing i18n keys it will not — i18n keys are not type-checked here — but do Task 13 before manual UI testing.)

- [ ] **Step 5: Commit**

```bash
git add pages/traffic.vue
git commit -m "feat(data-usage): route clear/retention by collector mode"
```

---

## Task 13: i18n keys (en / zh / ru)

**Files:**
- Modify: `i18n/locales/en.json`
- Modify: `i18n/locales/zh.json`
- Modify: `i18n/locales/ru.json`

- [ ] **Step 1: Add English keys**

In `i18n/locales/en.json`, after the `enableDataUsageTrackingDesc` line (line 123), insert:

```json
  "enableBackgroundCollector": "Background Collector",
  "enableBackgroundCollectorDesc": "Read traffic stats from a standalone collector daemon instead of the browser. The daemon must be running separately; only then does data keep accumulating after the browser is fully closed.",
  "collectorURL": "Collector URL",
  "collectorToken": "Collector Token",
  "collectorManagesRetention": "Retention is managed by the collector",
  "collectorUnreachable": "Collector unreachable",
```

- [ ] **Step 2: Add Chinese keys**

In `i18n/locales/zh.json`, after the `enableDataUsageTrackingDesc` line (line 123), insert:

```json
  "enableBackgroundCollector": "后台采集器",
  "enableBackgroundCollectorDesc": "从独立的采集器进程（而非浏览器）读取流量统计。该进程需单独运行；只有这样，浏览器完全关闭后数据才会继续累计。",
  "collectorURL": "采集器地址",
  "collectorToken": "采集器令牌",
  "collectorManagesRetention": "保留时长由采集器管理",
  "collectorUnreachable": "采集器无法连接",
```

- [ ] **Step 3: Add Russian keys**

In `i18n/locales/ru.json`, after the `enableDataUsageTrackingDesc` line (line 123), insert:

```json
  "enableBackgroundCollector": "Фоновый сборщик",
  "enableBackgroundCollectorDesc": "Читать статистику трафика из отдельного процесса-сборщика, а не из браузера. Процесс должен работать отдельно; только тогда данные продолжают накапливаться после полного закрытия браузера.",
  "collectorURL": "URL сборщика",
  "collectorToken": "Токен сборщика",
  "collectorManagesRetention": "Срок хранения управляется сборщиком",
  "collectorUnreachable": "Сборщик недоступен",
```

- [ ] **Step 4: Validate JSON parses**

Run: `node -e "for (const l of ['en','zh','ru']) JSON.parse(require('fs').readFileSync('i18n/locales/'+l+'.json','utf8')); console.log('json ok')"`
Expected: `json ok`.

- [ ] **Step 5: Commit**

```bash
git add i18n/locales/en.json i18n/locales/zh.json i18n/locales/ru.json
git commit -m "i18n: add background collector strings"
```

---

## Task 14: Settings UI in the config page

**Files:**
- Modify: `pages/config.vue`

- [ ] **Step 1: Add the toggle + inputs**

In `pages/config.vue`, immediately after the `enableDataUsageTracking` toggle block (closes at line 568) and before the Mobile Bottom Nav comment (line 570), insert:

```html
              <div
                class="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5 transition-colors hover:bg-base-content/5"
              >
                <div class="flex flex-col gap-0.5">
                  <span class="text-sm">{{
                    t('enableBackgroundCollector')
                  }}</span>
                  <span class="text-xs opacity-50">{{
                    t('enableBackgroundCollectorDesc')
                  }}</span>
                </div>
                <input
                  v-model="configStore.enableBackgroundCollector"
                  type="checkbox"
                  class="toggle toggle-primary"
                />
              </div>

              <div
                v-if="configStore.enableBackgroundCollector"
                class="flex flex-col gap-2 rounded-lg px-2 py-1.5"
              >
                <label class="flex flex-col gap-1">
                  <span class="text-xs opacity-70">{{ t('collectorURL') }}</span>
                  <input
                    v-model="configStore.collectorURL"
                    type="url"
                    placeholder="http://localhost:9797"
                    class="input input-sm input-bordered w-full"
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-xs opacity-70">{{
                    t('collectorToken')
                  }}</span>
                  <input
                    v-model="configStore.collectorToken"
                    type="password"
                    class="input input-sm input-bordered w-full"
                  />
                </label>
              </div>
```

> `configStore` and `t` are already in scope in this file (the existing `enableDataUsageTracking` toggle uses both).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Manual UI check**

Run: `pnpm dev` and open the dashboard. Go to Config → XD Config. Verify:
- A "Background Collector" toggle appears under "Track Data Usage".
- Enabling it reveals the URL and Token inputs; values persist across reload (localStorage).
- Disabling hides them.

- [ ] **Step 4: Commit**

```bash
git add pages/config.vue
git commit -m "feat(config): add background collector settings UI"
```

---

## Task 15: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the collector against a real mihomo**

```bash
MIHOMO_API_URL=http://127.0.0.1:9090 MIHOMO_SECRET=<your-secret> \
PORT=9797 DB_PATH=./.collector-data.sqlite pnpm collector
```
Expected: `[collector] listening on :9797 ...` and no repeated reconnect spam (a reconnect line only if mihomo is down).

- [ ] **Step 2: Confirm data accrues**

After ~1 minute of traffic, in another shell:
```bash
curl -s "http://127.0.0.1:9797/api/health"
curl -s "http://127.0.0.1:9797/api/logs?start=0&end=$(($(date +%s)*1000))" | head -c 400
```
Expected: `count` > 0 and a JSON array of log rows.

- [ ] **Step 3: Wire the dashboard to the collector**

In `pnpm dev`, Config → XD Config → enable Background Collector, set URL `http://127.0.0.1:9797` (and token if you set `COLLECTOR_TOKEN`). Open the Data Usage page. Confirm rows render from the collector. Confirm the retention selector is disabled. Confirm the clear (trash) button empties the collector (`/api/health` count returns to 0).

- [ ] **Step 4: Confirm browser-quit survival (the actual requirement)**

Quit the browser entirely for ~2 minutes while traffic flows, then reopen the dashboard with Background Collector enabled. Confirm the Data Usage page shows traffic recorded during the window the browser was closed.

- [ ] **Step 5: Full check + final commit (if any tweaks were needed)**

```bash
pnpm test:unit && pnpm typecheck && pnpm typecheck:collector
```
Expected: all green. Commit any fixes made during verification.

---

## Notes for the implementer

- **`node:sqlite` experimental warning** is expected on every collector run and in store/server tests; it is not a failure.
- **Extensionless imports** in `collector/` are intentional — `tsx` resolves them and the bundler-resolution tsconfig typechecks them. Do not add `.ts` extensions.
- **`console.log` in `collector/`** is acceptable: it is a standalone CLI daemon, not frontend production code. Do not route it through the frontend logger.
- **Two intentional tracker differences** from the in-browser tracker (restart keeps history; first observation is baseline-only) are covered by `tracker.spec.ts` — preserve them.
- The collector dataset and the in-browser IndexedDB dataset are **separate**; collector mode only changes where the page reads from. This is by design.
