# Standalone Multi-Backend Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un-bundle the traffic collector from the dashboard into a standalone service (domain + API key access, no published ports) that collects from multiple mihomo backends simultaneously with per-backend data isolation.

**Architecture:** Same Docker image runs twice via compose `command:` override (no `ports:` — Coolify maps domains). The collector keeps one `MihomoClient` + one `Tracker` per registered backend in a new `collector/backends.ts` manager; SQLite gains a `backend` column and a `backends` registration table. `COLLECTOR_TOKEN` becomes mandatory. The frontend sends a `backend=<normalized mihomo URL>` param on every logs call and gets a small backend-management UI.

**Tech Stack:** Node 22+ (`node:sqlite`, `node:http`, native WebSocket), esbuild bundle, Nuxt 3 / Vue 3 / Pinia frontend, vitest, zod.

**Spec:** `docs/superpowers/specs/2026-06-10-standalone-multi-backend-collector-design.md`

**Conventions:**

- Run collector tests: `pnpm vitest run collector/ --exclude='e2e/**'`
- Run frontend tests: `pnpm vitest run composables/ stores/ --exclude='e2e/**'`
- Collector is zero-dependency: only `node:` imports and relative imports inside `collector/`.
- `normalizeBackend(raw)` = `new URL(raw).href.replace(/\/$/, '')` — duplicated once in `collector/backends.ts` and once in `utils/collector.ts` (the collector bundle cannot import from the Nuxt app; keep both 3-line copies in sync).

---

## File Structure

| File                                                 | Action  | Responsibility                                                                     |
| ---------------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `collector/config.ts`                                | Modify  | Env parsing; `COLLECTOR_TOKEN` now required; drop `mihomoWsURL`                    |
| `collector/store.ts`                                 | Modify  | Schema v2: `backend` column + `backends` table + migration; backend-aware API      |
| `collector/backends.ts`                              | Create  | Per-backend connection manager (client + tracker per backend), `normalizeBackend`  |
| `collector/server.ts`                                | Modify  | API v2: backend params, `/api/backends` endpoints, manager injection               |
| `collector/index.ts`                                 | Modify  | Wire config → store → manager → server; seed env backend; flush loop               |
| `collector/__tests__/config.spec.ts`                 | Modify  | Token-required tests                                                               |
| `collector/__tests__/store.spec.ts`                  | Rewrite | Per-backend isolation + migration tests                                            |
| `collector/__tests__/backends.spec.ts`               | Create  | Manager tests with fake connect factory                                            |
| `collector/__tests__/server.spec.ts`                 | Rewrite | API v2 tests                                                                       |
| `server/routes/__collector/[...].ts`                 | Delete  | Bundled-mode proxy removed                                                         |
| `docker-entrypoint.sh`                               | Modify  | Remove collector startup block                                                     |
| `docker-compose.yml`                                 | Rewrite | Two services, same image, no ports                                                 |
| `utils/collector.ts`                                 | Create  | Frontend `normalizeBackend`                                                        |
| `composables/useDataUsageSource.ts`                  | Modify  | `backend=` param; no `/__collector` fallback; IndexedDB fallback when unconfigured |
| `composables/useCollectorBackends.ts`                | Create  | List/remove collected backends (management logic)                                  |
| `composables/__tests__/useDataUsageSource.spec.ts`   | Modify  | Updated expectations                                                               |
| `composables/__tests__/useCollectorBackends.spec.ts` | Create  | Management logic tests                                                             |
| `components/CollectorBackends.vue`                   | Create  | Thin renderer for the backend list                                                 |
| `pages/config.vue`                                   | Modify  | Required-fields hint, health probe, embed `CollectorBackends`                      |
| `stores/config.ts`                                   | Modify  | Comment update only (default already `''`)                                         |
| `stores/__tests__/configCollector.spec.ts`           | Modify  | Test-name update                                                                   |
| `i18n/locales/{en,zh,ru}.json`                       | Modify  | Updated + new strings                                                              |

---

### Task 1: Collector config — require `COLLECTOR_TOKEN`

**Files:**

- Modify: `collector/config.ts`
- Test: `collector/__tests__/config.spec.ts`

- [ ] **Step 1: Update the config tests**

Replace the full contents of `collector/__tests__/config.spec.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig, toWsURL } from '../config'

describe('collector/config', () => {
  it('toWsURL converts http to ws and https to wss, trimming trailing slash', () => {
    expect(toWsURL('http://127.0.0.1:9090/')).toBe('ws://127.0.0.1:9090')
    expect(toWsURL('https://host:9090')).toBe('wss://host:9090')
  })

  it('throws when COLLECTOR_TOKEN is missing or empty', () => {
    expect(() => loadConfig({})).toThrow(/COLLECTOR_TOKEN/)
    expect(() => loadConfig({ COLLECTOR_TOKEN: '' })).toThrow(/COLLECTOR_TOKEN/)
  })

  it('defaults to an empty mihomo target when MIHOMO_API_URL is missing', () => {
    const cfg = loadConfig({ COLLECTOR_TOKEN: 'tok' })
    expect(cfg.mihomoApiURL).toBe('')
  })

  it('throws when MIHOMO_API_URL is not a valid URL', () => {
    expect(() =>
      loadConfig({ COLLECTOR_TOKEN: 'tok', MIHOMO_API_URL: 'not a url' }),
    ).toThrow(/not a valid URL/)
  })

  it('applies defaults', () => {
    const cfg = loadConfig({
      COLLECTOR_TOKEN: 'tok',
      MIHOMO_API_URL: 'http://127.0.0.1:9090',
    })
    expect(cfg).toMatchObject({
      mihomoApiURL: 'http://127.0.0.1:9090',
      mihomoSecret: '',
      port: 9797,
      dbPath: './collector-data.sqlite',
      retentionMs: 0,
      token: 'tok',
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run collector/__tests__/config.spec.ts`
Expected: FAIL — `loadConfig({})` does not throw, and `cfg` objects no longer match (old code requires nothing).

- [ ] **Step 3: Implement**

Replace the full contents of `collector/config.ts` with:

```ts
export interface CollectorConfig {
  mihomoApiURL: string
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
  // The collector is meant to be exposed through a public domain (reverse
  // proxy), so running without an API key is never acceptable.
  const token = env.COLLECTOR_TOKEN ?? ''
  if (!token) {
    throw new Error(
      'COLLECTOR_TOKEN is required (set it to the API key the dashboard will use)',
    )
  }

  // MIHOMO_API_URL is an optional seed backend: more backends register at
  // runtime via POST /api/connect and persist in the database.
  const mihomoApiURL = env.MIHOMO_API_URL ?? ''
  if (mihomoApiURL) {
    try {
      void new URL(mihomoApiURL)
    } catch {
      throw new Error(`MIHOMO_API_URL is not a valid URL: ${mihomoApiURL}`)
    }
  }

  return {
    mihomoApiURL,
    mihomoSecret: env.MIHOMO_SECRET ?? '',
    port: Number(env.PORT ?? 9797),
    dbPath: env.DB_PATH ?? './collector-data.sqlite',
    retentionMs: Number(env.RETENTION_MS ?? 0),
    token,
    allowedOrigin: env.ALLOWED_ORIGIN ?? '*',
  }
}
```

Note: `mihomoWsURL` is removed from the interface — Task 3's manager derives the WS URL per backend via `toWsURL`. `collector/index.ts` still compiles because it only reads `config.mihomoApiURL`/`config.mihomoSecret` (it calls `toWsURL` itself); it is rewritten in Task 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run collector/__tests__/config.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add collector/config.ts collector/__tests__/config.spec.ts
git commit -m "feat(collector): require COLLECTOR_TOKEN at startup"
```

---

### Task 2: Store schema v2 — per-backend data + registrations + migration

**Files:**

- Modify: `collector/store.ts`
- Test: `collector/__tests__/store.spec.ts`

- [ ] **Step 1: Rewrite the store tests**

Replace the full contents of `collector/__tests__/store.spec.ts` with:

```ts
import type { Store } from '../store'
import type { DataUsageLog } from '../types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../store'

const A = 'http://mihomo-a:9090'
const B = 'http://mihomo-b:9090'

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

  afterEach(() => {
    store.close()
  })

  it('partitions logs by backend', () => {
    store.insertLogs(A, [makeLog({ host: 'a.com' })])
    store.insertLogs(B, [makeLog({ host: 'b.com' })])

    expect(store.query(A, 0, 100000).map((r) => r.host)).toEqual(['a.com'])
    expect(store.query(B, 0, 100000).map((r) => r.host)).toEqual(['b.com'])
    expect(store.countByBackend(A)).toBe(1)
    expect(store.count()).toBe(2)
  })

  it('queries logs within a time range, ordered by timestamp', () => {
    store.insertLogs(A, [
      makeLog({ timestamp: 120000, host: 'late.com' }),
      makeLog({ timestamp: 60000, host: 'early.com' }),
      makeLog({ timestamp: 999999999, host: 'future.com' }),
    ])

    const rows = store.query(A, 0, 200000)

    expect(rows.map((r) => r.host)).toEqual(['early.com', 'late.com'])
  })

  it('clearBackend removes only that backend logs', () => {
    store.insertLogs(A, [makeLog()])
    store.insertLogs(B, [makeLog()])

    store.clearBackend(A)

    expect(store.countByBackend(A)).toBe(0)
    expect(store.countByBackend(B)).toBe(1)
  })

  it('upserts and lists backend registrations', () => {
    store.upsertBackend(A, 's1')
    store.upsertBackend(B, 's2')
    store.upsertBackend(A, 's1-new')

    const rows = store.listBackends()
    expect(rows.map((r) => r.url)).toEqual([A, B])
    expect(rows[0]!.secret).toBe('s1-new')
    expect(rows[0]!.addedAt).toBeGreaterThan(0)
  })

  it('removeBackend drops the registration and its logs', () => {
    store.upsertBackend(A, 's1')
    store.upsertBackend(B, 's2')
    store.insertLogs(A, [makeLog()])
    store.insertLogs(B, [makeLog()])

    store.removeBackend(A)

    expect(store.listBackends().map((r) => r.url)).toEqual([B])
    expect(store.countByBackend(A)).toBe(0)
    expect(store.countByBackend(B)).toBe(1)
  })

  it('cleanup deletes rows older than the cutoff across backends', () => {
    store.insertLogs(A, [makeLog({ timestamp: 1000 })])
    store.insertLogs(B, [makeLog({ timestamp: 5000 })])

    store.cleanup(3000)

    expect(store.count()).toBe(1)
    expect(store.query(B, 0, 10000)[0]!.timestamp).toBe(5000)
  })

  it('insertLogs is a no-op for an empty array', () => {
    store.insertLogs(A, [])
    expect(store.count()).toBe(0)
  })

  it('migrates a v1 database: adds the backend column, keeps legacy rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'collector-store-'))
    const dbPath = join(dir, 'v1.sqlite')

    const v1 = new DatabaseSync(dbPath)
    v1.exec(`
      CREATE TABLE data_usage_logs (
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
      CREATE INDEX idx_timestamp ON data_usage_logs (timestamp);
      INSERT INTO data_usage_logs
        (timestamp, sourceIP, host, outbound, process, inboundUser, upload, download)
      VALUES (60000, '10.0.0.1', 'legacy.com', 'PROXY', 'curl', 'Unknown', 1, 2);
    `)
    v1.close()

    const migrated = createStore(dbPath)
    // Legacy rows keep backend='' — preserved but invisible to per-backend queries.
    expect(migrated.count()).toBe(1)
    expect(migrated.query(A, 0, 100000)).toEqual([])
    migrated.insertLogs(A, [makeLog()])
    expect(migrated.countByBackend(A)).toBe(1)
    migrated.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run collector/__tests__/store.spec.ts`
Expected: FAIL — type errors / wrong arity (`insertLogs` takes one arg in v1) and missing methods.

- [ ] **Step 3: Implement**

Replace the full contents of `collector/store.ts` with:

```ts
import type { DataUsageLog } from './types'
import { DatabaseSync } from 'node:sqlite'

export interface BackendRow {
  url: string
  secret: string
  addedAt: number
}

export interface Store {
  insertLogs: (backend: string, logs: DataUsageLog[]) => void
  query: (backend: string, start: number, end: number) => DataUsageLog[]
  clearBackend: (backend: string) => void
  upsertBackend: (url: string, secret: string) => void
  removeBackend: (backend: string) => void
  listBackends: () => BackendRow[]
  countByBackend: (backend: string) => number
  count: () => number
  cleanup: (before: number) => void
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
      download INTEGER NOT NULL,
      backend TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS backends (
      url TEXT PRIMARY KEY,
      secret TEXT NOT NULL,
      addedAt INTEGER NOT NULL
    );
  `)

  // v1 databases predate the backend column; legacy rows keep backend='' —
  // invisible to per-backend queries, intentionally preserved.
  const cols = db.prepare('PRAGMA table_info(data_usage_logs)').all() as {
    name: string
  }[]
  if (!cols.some((c) => c.name === 'backend')) {
    db.exec(
      "ALTER TABLE data_usage_logs ADD COLUMN backend TEXT NOT NULL DEFAULT ''",
    )
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_timestamp;
    CREATE INDEX IF NOT EXISTS idx_backend_timestamp
      ON data_usage_logs (backend, timestamp);
  `)

  const insertStmt = db.prepare(
    `INSERT INTO data_usage_logs
       (backend, timestamp, sourceIP, host, outbound, process, inboundUser, upload, download)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const queryStmt = db.prepare(
    `SELECT id, timestamp, sourceIP, host, outbound, process, inboundUser, upload, download
       FROM data_usage_logs
      WHERE backend = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC`,
  )
  const clearBackendStmt = db.prepare(
    'DELETE FROM data_usage_logs WHERE backend = ?',
  )
  const upsertBackendStmt = db.prepare(
    `INSERT INTO backends (url, secret, addedAt) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET secret = excluded.secret`,
  )
  const removeBackendStmt = db.prepare('DELETE FROM backends WHERE url = ?')
  const listBackendsStmt = db.prepare(
    'SELECT url, secret, addedAt FROM backends ORDER BY addedAt ASC, url ASC',
  )
  const countByBackendStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM data_usage_logs WHERE backend = ?',
  )
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM data_usage_logs')
  const cleanupStmt = db.prepare(
    'DELETE FROM data_usage_logs WHERE timestamp < ?',
  )

  return {
    insertLogs(backend, logs) {
      if (logs.length === 0) return
      db.exec('BEGIN')
      try {
        for (const l of logs) {
          insertStmt.run(
            backend,
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
    query(backend, start, end) {
      return queryStmt.all(backend, start, end) as unknown as DataUsageLog[]
    },
    clearBackend(backend) {
      clearBackendStmt.run(backend)
    },
    upsertBackend(url, secret) {
      upsertBackendStmt.run(url, secret, Date.now())
    },
    removeBackend(backend) {
      clearBackendStmt.run(backend)
      removeBackendStmt.run(backend)
    },
    listBackends() {
      return listBackendsStmt.all() as unknown as BackendRow[]
    },
    countByBackend(backend) {
      const row = countByBackendStmt.get(backend) as { n: number }
      return row.n
    },
    count() {
      const row = countStmt.get() as { n: number }
      return row.n
    },
    cleanup(before) {
      cleanupStmt.run(before)
    },
    close() {
      db.close()
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run collector/__tests__/store.spec.ts`
Expected: PASS (8 tests). Other collector specs (`server.spec.ts`) will now FAIL to compile — that is expected until Tasks 3–4; do not run the full suite yet.

- [ ] **Step 5: Commit**

```bash
git add collector/store.ts collector/__tests__/store.spec.ts
git commit -m "feat(collector): per-backend storage with registrations and v1 migration"
```

---

### Task 3: Backend manager — one client + tracker per backend

**Files:**

- Create: `collector/backends.ts`
- Test: `collector/__tests__/backends.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `collector/__tests__/backends.spec.ts`:

```ts
import type { MihomoClient, MihomoClientOptions } from '../mihomo'
import type { Store } from '../store'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBackendManager, normalizeBackend } from '../backends'
import { createStore } from '../store'

const A = 'http://mihomo-a:9090'
const B = 'http://mihomo-b:9090'

interface FakeConn {
  wsURL: string
  secret: string
  closed: boolean
  emit: (msg: unknown) => void
}

const makeFakeConnect = () => {
  const conns: FakeConn[] = []
  const connect = (opts: MihomoClientOptions): MihomoClient => {
    const conn: FakeConn = {
      wsURL: opts.wsURL,
      secret: opts.secret,
      closed: false,
      emit: (msg) => opts.onMessage(msg),
    }
    conns.push(conn)
    return {
      close: () => {
        conn.closed = true
      },
    }
  }
  return { conns, connect }
}

// Two messages: the first only sets the per-connection baseline, the second
// produces a 100-byte upload delta.
const feedDelta = (conn: FakeConn): void => {
  const meta = { sourceIP: '10.0.0.1', host: 'x.com' }
  conn.emit({
    uploadTotal: 100,
    downloadTotal: 0,
    connections: [
      { id: 'c1', upload: 100, download: 0, chains: ['PROXY'], metadata: meta },
    ],
  })
  conn.emit({
    uploadTotal: 200,
    downloadTotal: 0,
    connections: [
      { id: 'c1', upload: 200, download: 0, chains: ['PROXY'], metadata: meta },
    ],
  })
}

describe('collector/backends', () => {
  let store: Store

  beforeEach(() => {
    store = createStore(':memory:')
  })

  it('normalizeBackend lowercases the host and strips the trailing slash', () => {
    expect(normalizeBackend('HTTP://Mihomo-A:9090/')).toBe(
      'http://mihomo-a:9090',
    )
    expect(normalizeBackend('http://h:9090')).toBe('http://h:9090')
    expect(() => normalizeBackend('not a url')).toThrow()
  })

  it('upsert connects and persists the backend', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })

    manager.upsert(`${A}/`, 's1')

    expect(conns).toHaveLength(1)
    expect(conns[0]!.wsURL).toBe('ws://mihomo-a:9090')
    expect(conns[0]!.secret).toBe('s1')
    expect(store.listBackends().map((b) => b.url)).toEqual([A])
  })

  it('upsert with the same url and secret is a no-op', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })

    manager.upsert(A, 's1')
    manager.upsert(A, 's1')

    expect(conns).toHaveLength(1)
    expect(conns[0]!.closed).toBe(false)
  })

  it('upsert with a changed secret reconnects', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })

    manager.upsert(A, 's1')
    manager.upsert(A, 's2')

    expect(conns).toHaveLength(2)
    expect(conns[0]!.closed).toBe(true)
    expect(conns[1]!.secret).toBe('s2')
    expect(store.listBackends()[0]!.secret).toBe('s2')
  })

  it('drainAll tags drained logs with their backend', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, '')
    manager.upsert(B, '')

    feedDelta(conns[0]!)

    const drained = manager.drainAll()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.backend).toBe(A)
    expect(drained[0]!.logs[0]!.upload).toBe(100)
  })

  it('remove closes the connection and deletes registration and logs', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, '')
    store.insertLogs(A, [
      {
        timestamp: 1,
        sourceIP: '',
        host: '',
        outbound: '',
        process: '',
        inboundUser: '',
        upload: 1,
        download: 1,
      },
    ])

    manager.remove(A)

    expect(conns[0]!.closed).toBe(true)
    expect(store.listBackends()).toEqual([])
    expect(store.countByBackend(A)).toBe(0)
  })

  it('list reports registration, active flag and per-backend count', () => {
    const { connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, '')
    store.upsertBackend(B, '') // registered but never connected

    const list = manager.list()

    expect(list).toHaveLength(2)
    const a = list.find((x) => x.url === A)!
    const b = list.find((x) => x.url === B)!
    expect(a.connected).toBe(true)
    expect(b.connected).toBe(false)
  })

  it('loadPersisted connects every registered backend once', () => {
    store.upsertBackend(A, 's1')
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(B, 's2')

    manager.loadPersisted()
    manager.loadPersisted()

    expect(conns.map((c) => c.wsURL).sort()).toEqual([
      'ws://mihomo-a:9090',
      'ws://mihomo-b:9090',
    ])
  })

  it('closeAll closes every connection', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, '')
    manager.upsert(B, '')

    manager.closeAll()

    expect(conns.every((c) => c.closed)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run collector/__tests__/backends.spec.ts`
Expected: FAIL — `../backends` module not found.

- [ ] **Step 3: Implement**

Create `collector/backends.ts`:

```ts
import type { MihomoClient, MihomoClientOptions } from './mihomo'
import type { Store } from './store'
import type { ConnectionsMessage, DataUsageLog } from './types'
import type { Tracker } from './tracker'
import { toWsURL } from './config'
import { connectMihomo } from './mihomo'
import { createTracker } from './tracker'

// Keep in sync with utils/collector.ts (the frontend mirror).
export function normalizeBackend(raw: string): string {
  return new URL(raw).href.replace(/\/$/, '')
}

export interface BackendStatus {
  url: string
  addedAt: number
  connected: boolean
  count: number
}

export interface DrainedLogs {
  backend: string
  logs: DataUsageLog[]
}

export interface BackendManager {
  // Throws TypeError when the url is not parseable (callers map this to 400).
  upsert: (url: string, secret: string) => void
  remove: (url: string) => void
  list: () => BackendStatus[]
  drainAll: () => DrainedLogs[]
  loadPersisted: () => void
  closeAll: () => void
}

export interface BackendManagerOptions {
  store: Store
  log?: (msg: string) => void
  connect?: (opts: MihomoClientOptions) => MihomoClient
}

export function createBackendManager(
  opts: BackendManagerOptions,
): BackendManager {
  const { store } = opts
  const log = opts.log ?? (() => {})
  const connect = opts.connect ?? connectMihomo
  const active = new Map<
    string,
    { client: MihomoClient; tracker: Tracker; secret: string }
  >()

  const open = (url: string, secret: string): void => {
    // One tracker per backend: connection ids and cumulative totals are
    // per-backend state, sharing a tracker would corrupt the deltas.
    const tracker = createTracker()
    const client = connect({
      wsURL: toWsURL(url),
      secret,
      onMessage: (msg) => tracker.processMessage(msg as ConnectionsMessage),
      log: (m) => log(`[${url}] ${m}`),
    })
    active.set(url, { client, tracker, secret })
    log(`collecting from ${url}`)
  }

  return {
    upsert(rawUrl, secret) {
      const url = normalizeBackend(rawUrl)
      store.upsertBackend(url, secret)
      const existing = active.get(url)
      if (existing && existing.secret === secret) return
      existing?.client.close()
      open(url, secret)
    },
    remove(rawUrl) {
      const url = normalizeBackend(rawUrl)
      active.get(url)?.client.close()
      active.delete(url)
      store.removeBackend(url)
      log(`removed backend ${url}`)
    },
    list() {
      return store.listBackends().map((b) => ({
        url: b.url,
        addedAt: b.addedAt,
        connected: active.has(b.url),
        count: store.countByBackend(b.url),
      }))
    },
    drainAll() {
      const out: DrainedLogs[] = []
      for (const [backend, { tracker }] of active) {
        const logs = tracker.drainBuffer()
        if (logs.length > 0) out.push({ backend, logs })
      }
      return out
    },
    loadPersisted() {
      for (const b of store.listBackends()) {
        if (!active.has(b.url)) open(b.url, b.secret)
      }
    },
    closeAll() {
      for (const { client } of active.values()) client.close()
      active.clear()
    },
  }
}
```

Note: `connected` means "the manager holds an active client" (collecting), not live WS state — `mihomo.ts` reconnects internally and does not expose readyState.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run collector/__tests__/backends.spec.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add collector/backends.ts collector/__tests__/backends.spec.ts
git commit -m "feat(collector): backend manager with per-backend client and tracker"
```

---

### Task 4: Server API v2 — backend params, /api/backends, mandatory auth

**Files:**

- Modify: `collector/server.ts`
- Test: `collector/__tests__/server.spec.ts`

- [ ] **Step 1: Rewrite the server tests**

Replace the full contents of `collector/__tests__/server.spec.ts` with:

```ts
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BackendManager } from '../backends'
import type { MihomoClientOptions } from '../mihomo'
import type { Store } from '../store'
import type { DataUsageLog } from '../types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackendManager } from '../backends'
import { createServer } from '../server'
import { createStore } from '../store'

const A = 'http://mihomo-a:9090'
const TOKEN = 'secret'
const auth = { Authorization: `Bearer ${TOKEN}` }

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
  let manager: BackendManager
  let server: Server
  let base: string

  beforeEach(async () => {
    store = createStore(':memory:')
    manager = createBackendManager({
      store,
      connect: (_opts: MihomoClientOptions) => ({ close: () => {} }),
    })
    server = createServer({
      store,
      manager,
      token: TOKEN,
      allowedOrigin: '*',
      startedAt: 1000,
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
  })

  it('serves /api/health without auth', async () => {
    store.insertLogs(A, [makeLog()])
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, since: 1000, count: 1 })
  })

  it('rejects /api/logs without or with a wrong bearer token', async () => {
    expect((await fetch(`${base}/api/logs?backend=${A}`)).status).toBe(401)
    expect(
      (
        await fetch(`${base}/api/logs?backend=${A}`, {
          headers: { Authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401)
  })

  it('serves logs for the requested backend only, with CORS header', async () => {
    store.insertLogs(A, [makeLog({ host: 'a.com' })])
    store.insertLogs('http://other:9090', [makeLog({ host: 'b.com' })])

    const res = await fetch(
      `${base}/api/logs?backend=${encodeURIComponent(`${A}/`)}&start=0&end=100000`,
      { headers: auth },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const rows = (await res.json()) as DataUsageLog[]
    expect(rows.map((r) => r.host)).toEqual(['a.com'])
  })

  it('rejects /api/logs without a backend param', async () => {
    const res = await fetch(`${base}/api/logs?start=0&end=1`, {
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  it('rejects /api/logs with an invalid backend url', async () => {
    const res = await fetch(`${base}/api/logs?backend=not%20a%20url`, {
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  it('dELETE /api/logs clears only the requested backend', async () => {
    store.insertLogs(A, [makeLog()])
    store.insertLogs('http://other:9090', [makeLog()])

    const res = await fetch(
      `${base}/api/logs?backend=${encodeURIComponent(A)}`,
      { method: 'DELETE', headers: auth },
    )

    expect(res.status).toBe(200)
    expect(store.countByBackend(A)).toBe(0)
    expect(store.countByBackend('http://other:9090')).toBe(1)
  })

  it('dELETE /api/logs without a backend param is rejected', async () => {
    const res = await fetch(`${base}/api/logs`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  it('pOST /api/connect upserts the backend into the collection set', async () => {
    const res = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${A}/`, secret: 's3cr3t' }),
    })

    expect(res.status).toBe(200)
    expect(store.listBackends().map((b) => b.url)).toEqual([A])
  })

  it('pOST /api/connect rejects a missing or invalid url', async () => {
    const missing = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'x' }),
    })
    expect(missing.status).toBe(400)

    const invalid = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not a url' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('gET /api/backends lists registrations with status and count', async () => {
    manager.upsert(A, 's')
    store.insertLogs(A, [makeLog()])

    const res = await fetch(`${base}/api/backends`, { headers: auth })

    expect(res.status).toBe(200)
    const rows = (await res.json()) as {
      url: string
      connected: boolean
      count: number
      addedAt: number
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ url: A, connected: true, count: 1 })
  })

  it('dELETE /api/backends removes the backend and its data', async () => {
    manager.upsert(A, 's')
    store.insertLogs(A, [makeLog()])

    const res = await fetch(
      `${base}/api/backends?url=${encodeURIComponent(A)}`,
      { method: 'DELETE', headers: auth },
    )

    expect(res.status).toBe(200)
    expect(store.listBackends()).toEqual([])
    expect(store.countByBackend(A)).toBe(0)
  })

  it('dELETE /api/backends without url is rejected', async () => {
    const res = await fetch(`${base}/api/backends`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${base}/nope`, { headers: auth })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run collector/__tests__/server.spec.ts`
Expected: FAIL — `ServerOptions` has no `manager`, new routes missing.

- [ ] **Step 3: Implement**

Replace the full contents of `collector/server.ts` with:

```ts
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { BackendManager } from './backends'
import type { Store } from './store'
import { createServer as createHttpServer } from 'node:http'
import { normalizeBackend } from './backends'

export interface ServerOptions {
  store: Store
  manager: BackendManager
  token: string
  allowedOrigin: string
  startedAt: number
}

export function createServer(opts: ServerOptions): Server {
  const { store, manager, token, allowedOrigin, startedAt } = opts

  const setCors = (res: ServerResponse): void => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  }

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
      })
      req.on('end', () => resolve(data))
      req.on('error', () => resolve(''))
    })

  const isAuthorized = (req: IncomingMessage): boolean =>
    (req.headers.authorization ?? '') === `Bearer ${token}`

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  // Returns the normalized backend from a query param, or null (caller sends 400).
  const backendParam = (url: URL, name: string): string | null => {
    const raw = url.searchParams.get(name)
    if (!raw) return null
    try {
      return normalizeBackend(raw)
    } catch {
      return null
    }
  }

  return createHttpServer(async (req, res) => {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')

    try {
      // Health is public so the dashboard can probe reachability without a token.
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, { ok: true, since: startedAt, count: store.count() })
        return
      }

      if (!isAuthorized(req)) {
        json(res, 401, { error: 'unauthorized' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/connect') {
        let parsed: { url?: unknown; secret?: unknown }
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          json(res, 400, { error: 'invalid json' })
          return
        }
        if (typeof parsed.url !== 'string' || !parsed.url) {
          json(res, 400, { error: 'url is required' })
          return
        }
        const secret = typeof parsed.secret === 'string' ? parsed.secret : ''
        try {
          manager.upsert(parsed.url, secret)
        } catch {
          json(res, 400, { error: 'invalid url' })
          return
        }
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const backend = backendParam(url, 'backend')
        if (!backend) {
          json(res, 400, { error: 'backend is required' })
          return
        }
        const start = Number(url.searchParams.get('start')) || 0
        const endParam = Number(url.searchParams.get('end'))
        const end =
          Number.isFinite(endParam) && endParam > 0 ? endParam : Date.now()
        json(res, 200, store.query(backend, start, end))
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/api/logs') {
        const backend = backendParam(url, 'backend')
        if (!backend) {
          json(res, 400, { error: 'backend is required' })
          return
        }
        store.clearBackend(backend)
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/backends') {
        json(res, 200, manager.list())
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/api/backends') {
        const backend = backendParam(url, 'url')
        if (!backend) {
          json(res, 400, { error: 'url is required' })
          return
        }
        manager.remove(backend)
        json(res, 200, { ok: true })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch {
      json(res, 500, { error: 'internal error' })
    }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run collector/__tests__/server.spec.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add collector/server.ts collector/__tests__/server.spec.ts
git commit -m "feat(collector): API v2 with backend-scoped logs and backend management"
```

---

### Task 5: Wire it together in `collector/index.ts`

**Files:**

- Modify: `collector/index.ts`

No new unit test: `main()` is composition-only glue; every piece is covered by Tasks 1–4. Verification is the typecheck + a manual smoke test.

- [ ] **Step 1: Implement**

Replace the full contents of `collector/index.ts` with:

```ts
import type { CollectorConfig } from './config'
import { createBackendManager } from './backends'
import { loadConfig } from './config'
import { createServer } from './server'
import { createStore } from './store'

const FLUSH_INTERVAL_MS = 30000

function main(): void {
  let config: CollectorConfig
  try {
    config = loadConfig()
  } catch (e) {
    console.error(`[collector] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  const store = createStore(config.dbPath)
  const log = (m: string): void => console.log(`[collector] ${m}`)
  const manager = createBackendManager({ store, log })
  const startedAt = Date.now()

  // Optional seed backend from env; runtime registrations arrive via
  // POST /api/connect and persist in the backends table.
  if (config.mihomoApiURL) {
    manager.upsert(config.mihomoApiURL, config.mihomoSecret)
  }
  manager.loadPersisted()

  const flush = (): void => {
    for (const { backend, logs } of manager.drainAll()) {
      store.insertLogs(backend, logs)
    }
    if (config.retentionMs > 0) {
      store.cleanup(Date.now() - config.retentionMs)
    }
  }

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)

  const server = createServer({
    store,
    manager,
    token: config.token,
    allowedOrigin: config.allowedOrigin,
    startedAt,
  })
  server.listen(config.port, () => {
    log(`listening on :${config.port} db=${config.dbPath}`)
  })

  const shutdown = (): void => {
    clearInterval(flushTimer)
    flush()
    manager.closeAll()
    server.close()
    store.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
```

- [ ] **Step 2: Typecheck and run the whole collector suite**

Run: `pnpm typecheck:collector && pnpm vitest run collector/`
Expected: typecheck clean; all collector specs PASS (config, store, backends, server, mihomo, tracker).

- [ ] **Step 3: Manual smoke test**

```bash
COLLECTOR_TOKEN=devkey DB_PATH=/tmp/collector-smoke.sqlite pnpm collector &
sleep 1
curl -s localhost:9797/api/health                                  # → {"ok":true,...}
curl -s localhost:9797/api/backends                                # → {"error":"unauthorized"}
curl -s -H 'Authorization: Bearer devkey' localhost:9797/api/backends   # → []
curl -s -X POST -H 'Authorization: Bearer devkey' -H 'Content-Type: application/json' \
  -d '{"url":"http://127.0.0.1:9090","secret":""}' localhost:9797/api/connect  # → {"ok":true}
curl -s -H 'Authorization: Bearer devkey' localhost:9797/api/backends   # → [{"url":"http://127.0.0.1:9090",...}]
kill %1; rm -f /tmp/collector-smoke.sqlite
```

Also verify the token guard: `pnpm collector` (no env) must exit immediately with `COLLECTOR_TOKEN is required`.

- [ ] **Step 4: Commit**

```bash
git add collector/index.ts
git commit -m "feat(collector): wire multi-backend manager into the daemon"
```

---

### Task 6: Remove the bundled mode (Nitro proxy, entrypoint, compose)

**Files:**

- Delete: `server/routes/__collector/[...].ts`
- Modify: `docker-entrypoint.sh`
- Rewrite: `docker-compose.yml`

- [ ] **Step 1: Delete the Nitro proxy route**

```bash
rm server/routes/__collector/\[...\].ts && rmdir server/routes/__collector
```

- [ ] **Step 2: Simplify the entrypoint**

Replace the full contents of `docker-entrypoint.sh` with:

```sh
#!/bin/sh

set -eu

# Map DEFAULT_BACKEND_URL to Nuxt runtime config env var.
# Nitro embeds public asset metadata at build time, so do not rewrite config.js.
export NUXT_PUBLIC_DEFAULT_BACKEND_URL="${DEFAULT_BACKEND_URL:-}"

exec node /app/.output/server/index.mjs
```

- [ ] **Step 3: Rewrite the compose file**

Replace the full contents of `docker-compose.yml` with:

```yaml
# Dashboard + standalone traffic collector. No ports are published: attach your
# reverse proxy (e.g. Coolify) to the containers directly and map a domain to
# each service — dashboard on :80, collector on :9797.
#
# In the dashboard: Settings -> XD Config -> Background Collector, then enter
# the collector's public URL (your mapped domain) and the API key set below.
services:
  metacubexd:
    build: .
    image: metacubexd:local
    restart: always
    init: true

  collector:
    build: .
    image: metacubexd:local
    restart: always
    init: true
    command: ['node', '--no-warnings', '/app/collector/index.mjs']
    environment:
      PORT: '9797'
      DB_PATH: /data/collector.sqlite
      # Required. The dashboard authenticates with this key (Bearer token).
      COLLECTOR_TOKEN: ${COLLECTOR_TOKEN:?set an API key for the collector}
      # Optional seed backend; more backends register automatically when you
      # enable the collector in the dashboard (and persist across restarts).
      # MIHOMO_API_URL: 'http://your-mihomo-host:9090'
      # MIHOMO_SECRET: 'your-secret'
      # RETENTION_MS: '0'           # 0 = keep forever; e.g. 2592000000 = 30 days
      # ALLOWED_ORIGIN: '*'         # tighten to your dashboard origin if desired
    volumes:
      - collector-data:/data

volumes:
  collector-data:
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && docker compose config >/dev/null && echo OK`
Expected: typecheck clean (the deleted route had no importers); compose prints `OK` when run as `COLLECTOR_TOKEN=x docker compose config >/dev/null && echo OK` and errors without `COLLECTOR_TOKEN` (the `:?` guard working).

- [ ] **Step 5: Commit**

```bash
git add -A server/routes docker-entrypoint.sh docker-compose.yml
git commit -m "feat(deploy): un-bundle the collector into a standalone compose service"
```

---

### Task 7: Frontend data source — backend param, no built-in fallback

**Files:**

- Create: `utils/collector.ts`
- Modify: `composables/useDataUsageSource.ts`
- Test: `composables/__tests__/useDataUsageSource.spec.ts`

- [ ] **Step 1: Update the tests**

Replace the full contents of `composables/__tests__/useDataUsageSource.spec.ts` with:

```ts
// composables/__tests__/useDataUsageSource.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const endpointStore = {
  currentEndpoint: {
    id: 'e1',
    url: 'http://127.0.0.1:9090',
    secret: 'mihomo-secret',
  },
}

vi.stubGlobal('useConfigStore', () => configStore)
vi.stubGlobal('useEndpointStore', () => endpointStore)

// normalizeBackend('http://127.0.0.1:9090') -> 'http://127.0.0.1:9090'
const BACKEND = encodeURIComponent('http://127.0.0.1:9090')

beforeEach(() => {
  vi.clearAllMocks()
  configStore.enableBackgroundCollector = false
  configStore.collectorURL = 'http://collector:9797'
  configStore.collectorToken = 'tok'
  endpointStore.currentEndpoint = {
    id: 'e1',
    url: 'http://127.0.0.1:9090',
    secret: 'mihomo-secret',
  }
})

describe('composables/useDataUsageSource', () => {
  it('queries IndexedDB when the collector is disabled', async () => {
    dbQuery.mockResolvedValue([{ host: 'local' }])
    const { query } = useDataUsageSource()

    const rows = await query(0, 100)

    expect(dbQuery).toHaveBeenCalledWith(0, 100)
    expect(rows).toEqual([{ host: 'local' }])
  })

  it('queries the collector with the current backend when enabled', async () => {
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
      `http://collector:9797/api/logs?backend=${BACKEND}&start=10&end=20`,
      { headers: { Authorization: 'Bearer tok' } },
    )
    expect(rows).toEqual([row])
  })

  it('falls back to IndexedDB when enabled but no collector URL is set', async () => {
    configStore.enableBackgroundCollector = true
    configStore.collectorURL = ''
    dbQuery.mockResolvedValue([])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { query } = useDataUsageSource()
    await query(0, 1)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(dbQuery).toHaveBeenCalledWith(0, 1)
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

  it('configureCollector POSTs the current endpoint to /api/connect', async () => {
    configStore.enableBackgroundCollector = true
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const { configureCollector } = useDataUsageSource()
    await configureCollector()

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

  it('configureCollector is a no-op without an endpoint or collector URL', async () => {
    configStore.enableBackgroundCollector = true
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    configStore.collectorURL = ''
    const source = useDataUsageSource()
    await source.configureCollector()

    configStore.collectorURL = 'http://collector:9797'
    endpointStore.currentEndpoint =
      null as unknown as typeof endpointStore.currentEndpoint
    await source.configureCollector()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clearCollectorData issues a backend-scoped DELETE', async () => {
    configStore.enableBackgroundCollector = true
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const { clearCollectorData } = useDataUsageSource()
    await clearCollectorData()

    expect(fetchMock).toHaveBeenCalledWith(
      `http://collector:9797/api/logs?backend=${BACKEND}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer tok' },
      },
    )
  })

  it('clearCollectorData throws when the collector is not configured', async () => {
    configStore.enableBackgroundCollector = true
    configStore.collectorURL = ''
    const { clearCollectorData } = useDataUsageSource()
    await expect(clearCollectorData()).rejects.toThrow(/not configured/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run composables/__tests__/useDataUsageSource.spec.ts`
Expected: FAIL — no `backend` param sent, blank URL still targets `/__collector`.

- [ ] **Step 3: Implement**

Create `utils/collector.ts`:

```ts
// Keep in sync with collector/backends.ts (the daemon's copy — the
// zero-dependency collector bundle cannot import app code).
export function normalizeBackend(raw: string): string {
  return new URL(raw).href.replace(/\/$/, '')
}
```

Replace the full contents of `composables/useDataUsageSource.ts` with:

```ts
// composables/useDataUsageSource.ts
import type { DataUsageLog } from '~/utils/db'
import { z } from 'zod'
import { normalizeBackend } from '~/utils/collector'
import { db } from '~/utils/db'

export interface DataUsageSource {
  query: (start: number, end: number) => Promise<DataUsageLog[]>
  clearCollectorData: () => Promise<void>
  configureCollector: () => Promise<void>
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
  const endpointStore = useEndpointStore()

  const authHeaders = (): Record<string, string> =>
    configStore.collectorToken
      ? { Authorization: `Bearer ${configStore.collectorToken}` }
      : {}

  const collectorBase = (): string =>
    configStore.collectorURL.replace(/\/$/, '')

  // The collector partitions data per mihomo backend; every logs call is
  // scoped to the dashboard's currently selected endpoint.
  const currentBackend = (): string => {
    const endpoint = endpointStore.currentEndpoint
    if (!endpoint) return ''
    try {
      return normalizeBackend(endpoint.url)
    } catch {
      return ''
    }
  }

  const collectorReady = (): boolean =>
    Boolean(configStore.enableBackgroundCollector) &&
    collectorBase() !== '' &&
    currentBackend() !== ''

  const queryCollector = async (
    start: number,
    end: number,
  ): Promise<DataUsageLog[]> => {
    const backend = encodeURIComponent(currentBackend())
    const res = await fetch(
      `${collectorBase()}/api/logs?backend=${backend}&start=${start}&end=${end}`,
      { headers: authHeaders() },
    )
    if (!res.ok) {
      throw new Error(`Collector request failed with status ${res.status}`)
    }
    return dataUsageLogsSchema.parse(await res.json())
  }

  const query = (start: number, end: number): Promise<DataUsageLog[]> =>
    collectorReady() ? queryCollector(start, end) : db.query(start, end)

  const clearCollectorData = async (): Promise<void> => {
    if (!collectorReady()) {
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

  return { query, clearCollectorData, configureCollector }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run composables/__tests__/useDataUsageSource.spec.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add utils/collector.ts composables/useDataUsageSource.ts composables/__tests__/useDataUsageSource.spec.ts
git commit -m "feat(data-usage): scope collector calls to the current backend"
```

---

### Task 8: Backend management composable

**Files:**

- Create: `composables/useCollectorBackends.ts`
- Test: `composables/__tests__/useCollectorBackends.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `composables/__tests__/useCollectorBackends.spec.ts`:

```ts
// composables/__tests__/useCollectorBackends.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollectorBackends } from '../useCollectorBackends'

const configStore = {
  collectorURL: 'http://collector:9797',
  collectorToken: 'tok',
}

vi.stubGlobal('useConfigStore', () => configStore)

const row = {
  url: 'http://127.0.0.1:9090',
  addedAt: 1000,
  connected: true,
  count: 5,
}

beforeEach(() => {
  vi.clearAllMocks()
  configStore.collectorURL = 'http://collector:9797'
  configStore.collectorToken = 'tok'
})

describe('composables/useCollectorBackends', () => {
  it('refresh fetches and stores the backend list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [row] })
    vi.stubGlobal('fetch', fetchMock)

    const { backends, refresh } = useCollectorBackends()
    await refresh()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://collector:9797/api/backends',
      { headers: { Authorization: 'Bearer tok' } },
    )
    expect(backends.value).toEqual([row])
  })

  it('refresh flags an error on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    )

    const { error, refresh } = useCollectorBackends()
    await refresh()

    expect(error.value).toBe(true)
  })

  it('refresh is a no-op when no collector URL is set', async () => {
    configStore.collectorURL = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { refresh } = useCollectorBackends()
    await refresh()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('remove DELETEs the backend then refreshes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)

    const { remove } = useCollectorBackends()
    await remove('http://127.0.0.1:9090')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `http://collector:9797/api/backends?url=${encodeURIComponent('http://127.0.0.1:9090')}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://collector:9797/api/backends',
      { headers: { Authorization: 'Bearer tok' } },
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run composables/__tests__/useCollectorBackends.spec.ts`
Expected: FAIL — module not found.

Note: `useDataUsageSource.spec.ts` works with plain `vi.stubGlobal` for store composables and no Vue runtime — `ref` is auto-imported in source but in tests it resolves through the existing vitest setup. Check `vitest.config.ts`/`vitest.setup.ts` for how auto-imports are provided; if `ref` is not globally available in the test environment, import it explicitly in the composable (`import { ref } from 'vue'`), which is valid Nuxt code as well.

- [ ] **Step 3: Implement**

Create `composables/useCollectorBackends.ts`:

```ts
// composables/useCollectorBackends.ts
import type { Ref } from 'vue'
import { ref } from 'vue'
import { z } from 'zod'

const backendSchema = z.object({
  url: z.string(),
  addedAt: z.number(),
  connected: z.boolean(),
  count: z.number(),
})
const backendsSchema = z.array(backendSchema)

export type CollectorBackend = z.infer<typeof backendSchema>

export interface CollectorBackends {
  backends: Ref<CollectorBackend[]>
  error: Ref<boolean>
  refresh: () => Promise<void>
  remove: (url: string) => Promise<void>
}

export function useCollectorBackends(): CollectorBackends {
  const configStore = useConfigStore()
  const backends = ref<CollectorBackend[]>([])
  const error = ref(false)

  const base = (): string => configStore.collectorURL.replace(/\/$/, '')

  const authHeaders = (): Record<string, string> =>
    configStore.collectorToken
      ? { Authorization: `Bearer ${configStore.collectorToken}` }
      : {}

  const refresh = async (): Promise<void> => {
    if (!base()) return
    try {
      const res = await fetch(`${base()}/api/backends`, {
        headers: authHeaders(),
      })
      if (!res.ok) {
        error.value = true
        return
      }
      backends.value = backendsSchema.parse(await res.json())
      error.value = false
    } catch {
      error.value = true
    }
  }

  const remove = async (url: string): Promise<void> => {
    const res = await fetch(
      `${base()}/api/backends?url=${encodeURIComponent(url)}`,
      { method: 'DELETE', headers: authHeaders() },
    )
    if (!res.ok) {
      throw new Error(
        `Collector backend removal failed with status ${res.status}`,
      )
    }
    await refresh()
  }

  return { backends, error, refresh, remove }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run composables/__tests__/useCollectorBackends.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add composables/useCollectorBackends.ts composables/__tests__/useCollectorBackends.spec.ts
git commit -m "feat(data-usage): composable to list and remove collected backends"
```

---

### Task 9: Settings UI + i18n

**Files:**

- Create: `components/CollectorBackends.vue`
- Modify: `pages/config.vue:588-616` (collector settings block)
- Modify: `stores/config.ts:177-180` (comment only)
- Modify: `stores/__tests__/configCollector.spec.ts:12` (test name only)
- Modify: `i18n/locales/en.json`, `i18n/locales/zh.json`, `i18n/locales/ru.json`

- [ ] **Step 1: Update i18n**

In `i18n/locales/en.json`, replace the existing collector entries and add the new keys (keep them grouped where the current collector keys live, around line 124):

```json
"enableBackgroundCollector": "Background Collector",
"enableBackgroundCollectorDesc": "Record traffic 24/7 via a standalone collector service — stats keep accumulating even when the browser is closed. Deploy it separately and point the dashboard at its domain.",
"collectorURL": "Collector URL",
"collectorURLPlaceholder": "https://collector.example.com",
"collectorURLHint": "Public address of your standalone collector (e.g. the domain mapped by your reverse proxy).",
"collectorToken": "Collector API Key",
"collectorManagesRetention": "Retention is managed by the collector",
"collectorConfigIncomplete": "Collector URL and API key are both required.",
"collectorHealthOk": "Collector reachable",
"collectorHealthFail": "Collector unreachable",
"collectorBackends": "Collected Backends",
"collectorBackendsEmpty": "No backends are being collected yet.",
"collectorBackendConnected": "Collecting",
"collectorBackendDisconnected": "Not collecting",
"collectorBackendLogs": "{count} records",
"collectorBackendRemove": "Remove",
"collectorBackendRemoveConfirm": "Stop collecting this backend and delete all of its stored data?",
```

In `i18n/locales/zh.json` (same position):

```json
"enableBackgroundCollector": "后台采集器",
"enableBackgroundCollectorDesc": "通过独立部署的采集器服务 7x24 持续记录流量，浏览器关闭也能继续统计。需单独部署，并在此填写其访问域名。",
"collectorURL": "采集器地址",
"collectorURLPlaceholder": "https://collector.example.com",
"collectorURLHint": "独立采集器的公开地址（例如反向代理映射的域名）。",
"collectorToken": "采集器 API 密钥",
"collectorManagesRetention": "保留时长由采集器管理",
"collectorConfigIncomplete": "采集器地址与 API 密钥均为必填。",
"collectorHealthOk": "采集器连接正常",
"collectorHealthFail": "无法连接采集器",
"collectorBackends": "采集中的后端",
"collectorBackendsEmpty": "暂无正在采集的后端。",
"collectorBackendConnected": "采集中",
"collectorBackendDisconnected": "未连接",
"collectorBackendLogs": "{count} 条记录",
"collectorBackendRemove": "移除",
"collectorBackendRemoveConfirm": "停止采集该后端并删除其全部已存数据？",
```

In `i18n/locales/ru.json` (same position):

```json
"enableBackgroundCollector": "Фоновый сборщик",
"enableBackgroundCollectorDesc": "Записывайте трафик 24/7 через отдельный сервис-сборщик — статистика накапливается даже при закрытом браузере. Разверните его отдельно и укажите его домен.",
"collectorURL": "URL сборщика",
"collectorURLPlaceholder": "https://collector.example.com",
"collectorURLHint": "Публичный адрес отдельного сборщика (например, домен обратного прокси).",
"collectorToken": "API-ключ сборщика",
"collectorManagesRetention": "Срок хранения управляется сборщиком",
"collectorConfigIncomplete": "URL сборщика и API-ключ обязательны.",
"collectorHealthOk": "Сборщик доступен",
"collectorHealthFail": "Сборщик недоступен",
"collectorBackends": "Собираемые бэкенды",
"collectorBackendsEmpty": "Пока нет собираемых бэкендов.",
"collectorBackendConnected": "Сбор идёт",
"collectorBackendDisconnected": "Не подключён",
"collectorBackendLogs": "{count} записей",
"collectorBackendRemove": "Удалить",
"collectorBackendRemoveConfirm": "Прекратить сбор с этого бэкенда и удалить все его данные?",
```

- [ ] **Step 2: Create the backend list component**

Create `components/CollectorBackends.vue`:

```vue
<script setup lang="ts">
const { t } = useI18n()
const { backends, error, refresh, remove } = useCollectorBackends()

onMounted(() => {
  refresh().catch(() => {})
})

const handleRemove = async (url: string): Promise<void> => {
  if (!confirm(t('collectorBackendRemoveConfirm'))) return
  try {
    await remove(url)
  } catch {
    // surfaced via the error flag on the next refresh
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <span class="text-xs opacity-70">{{ t('collectorBackends') }}</span>
    <span v-if="error" class="text-xs text-error">
      {{ t('collectorHealthFail') }}
    </span>
    <span v-else-if="backends.length === 0" class="text-xs opacity-40">
      {{ t('collectorBackendsEmpty') }}
    </span>
    <div
      v-for="b in backends"
      :key="b.url"
      class="flex items-center justify-between gap-2 rounded-lg bg-base-content/5 px-2 py-1.5"
    >
      <div class="flex min-w-0 flex-col">
        <span class="truncate text-xs">{{ b.url }}</span>
        <span class="text-xs opacity-50">
          {{
            b.connected
              ? t('collectorBackendConnected')
              : t('collectorBackendDisconnected')
          }}
          · {{ t('collectorBackendLogs', { count: b.count }) }}
        </span>
      </div>
      <button
        class="btn text-error btn-ghost btn-xs"
        @click="handleRemove(b.url)"
      >
        {{ t('collectorBackendRemove') }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Update the collector block in `pages/config.vue`**

In the `<script setup>` section of `pages/config.vue`, add (near the other store setups; find `useConfigStore()` usage):

```ts
const collectorHealth = ref<'idle' | 'ok' | 'fail'>('idle')

const probeCollector = useDebounceFn(async () => {
  const base = configStore.collectorURL.replace(/\/$/, '')
  if (!configStore.enableBackgroundCollector || !base) {
    collectorHealth.value = 'idle'
    return
  }
  try {
    const res = await fetch(`${base}/api/health`)
    collectorHealth.value = res.ok ? 'ok' : 'fail'
  } catch {
    collectorHealth.value = 'fail'
  }
}, 500)

watch(
  () => [configStore.enableBackgroundCollector, configStore.collectorURL],
  () => {
    void probeCollector()
  },
  { immediate: true },
)
```

(`useDebounceFn` comes from `@vueuse/core`, auto-imported like `useLocalStorage` already used in `stores/config.ts`.)

Then replace the collector fields block (currently `pages/config.vue:588-616`, the `v-if="configStore.enableBackgroundCollector"` div) with:

```vue
<div
  v-if="configStore.enableBackgroundCollector"
  class="flex flex-col gap-2 rounded-lg px-2 py-1.5"
>
  <label class="flex flex-col gap-1">
    <span class="text-xs opacity-70">{{ t('collectorURL') }}</span>
    <input
      v-model="configStore.collectorURL"
      type="url"
      required
      :placeholder="t('collectorURLPlaceholder')"
      class="input-bordered input input-sm w-full"
    />
    <span class="text-xs opacity-40">{{ t('collectorURLHint') }}</span>
  </label>
  <label class="flex flex-col gap-1">
    <span class="text-xs opacity-70">{{ t('collectorToken') }}</span>
    <input
      v-model="configStore.collectorToken"
      type="password"
      required
      class="input-bordered input input-sm w-full"
    />
  </label>
  <span
    v-if="!configStore.collectorURL || !configStore.collectorToken"
    class="text-xs text-warning"
  >
    {{ t('collectorConfigIncomplete') }}
  </span>
  <span v-else-if="collectorHealth === 'ok'" class="text-xs text-success">
    {{ t('collectorHealthOk') }}
  </span>
  <span v-else-if="collectorHealth === 'fail'" class="text-xs text-error">
    {{ t('collectorHealthFail') }}
  </span>
  <CollectorBackends
    v-if="configStore.collectorURL && configStore.collectorToken"
  />
</div>
```

- [ ] **Step 4: Update the stale comment in `stores/config.ts`**

Replace the comment block above `collectorURL` (`stores/config.ts:177-180`) with:

```ts
// Address + API key of the standalone collector service (required when the
// feature is enabled). Typically a domain mapped by a reverse proxy to the
// collector container, e.g. https://collector.example.com.
```

- [ ] **Step 5: Update the test name in `stores/__tests__/configCollector.spec.ts`**

Change line 12 from:

```ts
  it('defaults the collector off, with no URL (uses the built-in proxy)', () => {
```

to:

```ts
  it('defaults the collector off, with no URL configured', () => {
```

- [ ] **Step 6: Verify in the browser**

```bash
pnpm dev:mock
```

In the browser (golden path + edge cases):

1. Settings → XD Config → enable Background Collector → with blank fields the warning `collectorConfigIncomplete` shows; no backend list.
2. Start a local collector: `COLLECTOR_TOKEN=devkey DB_PATH=/tmp/cb.sqlite pnpm collector`. Enter `http://localhost:9797` + `devkey` → health turns to "Collector reachable", the backend list appears and (after the auto-sync watcher fires) shows the current mock endpoint as collecting.
3. Remove the backend via the list → confirm dialog → row disappears.
4. Switch language to 中文 and verify the new strings render.
5. Data Usage page still renders with the collector disabled (IndexedDB path regression check).

- [ ] **Step 7: Run frontend tests + typecheck**

Run: `pnpm vitest run composables/ stores/ --exclude='e2e/**' && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add components/CollectorBackends.vue pages/config.vue stores/config.ts stores/__tests__/configCollector.spec.ts i18n/locales/en.json i18n/locales/zh.json i18n/locales/ru.json
git commit -m "feat(config): standalone collector settings with health probe and backend management"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite + typechecks + bundle**

Run: `pnpm test:unit && pnpm typecheck && pnpm typecheck:collector && pnpm build:collector`
Expected: all tests PASS, both typechecks clean, esbuild bundle succeeds.

- [ ] **Step 2: Compose build sanity**

Run: `COLLECTOR_TOKEN=devkey docker compose build && COLLECTOR_TOKEN=devkey docker compose up -d && docker compose ps && docker compose logs collector | head`
Expected: both containers `running`; collector logs `listening on :9797`. The dashboard publishes no ports (`docker compose ps` shows none).
Then: `docker compose down`.

- [ ] **Step 3: Commit any leftovers and report**

```bash
git status
```

If clean, done. The branch `feat/background-traffic-collector` has open PR renhedata/metacubexd#3 — ask the user whether to push and update the PR description (do not push without confirmation).
