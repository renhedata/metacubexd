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
