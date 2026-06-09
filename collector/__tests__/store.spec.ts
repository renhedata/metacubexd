import type {Store} from '../store';
import type { DataUsageLog } from '../types'
import { beforeEach, describe, expect, it } from 'vitest'
import { createStore  } from '../store'

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
