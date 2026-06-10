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

    const firstAddedAt = rows[0]!.addedAt
    store.upsertBackend(A, 's1-final')
    expect(store.listBackends()[0]!.addedAt).toBe(firstAddedAt)
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
    try {
      // Legacy rows keep backend='' — preserved but invisible to per-backend queries.
      expect(migrated.count()).toBe(1)
      expect(migrated.query(A, 0, 100000)).toEqual([])
      migrated.insertLogs(A, [makeLog()])
      expect(migrated.countByBackend(A)).toBe(1)
    } finally {
      migrated.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
