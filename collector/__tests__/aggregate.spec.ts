import type { AggregateQuery, DataUsageLog } from '../types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAggregateReader } from '../aggregate'
import { createStore } from '../store'

it('keeps worker reads current after writes, cancellation and query errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-aggregate-'))
  const path = join(dir, 'traffic.sqlite')
  const store = createStore(path)
  const reader = createAggregateReader(path)
  const backend = 'http://mihomo:9090'
  const log: DataUsageLog = {
    timestamp: 1000,
    sourceIP: '10.0.0.1',
    host: 'example.com',
    outbound: 'DIRECT',
    process: '',
    inboundUser: '',
    upload: 5,
    download: 10,
  }
  const query: AggregateQuery = { start: 0, end: 2000, groupBy: 'host' }
  try {
    store.insertLogs(backend, [log])
    const active = new AbortController()
    const queued = new AbortController()
    const first = reader.aggregate(backend, query, active.signal)
    const second = reader.aggregate(backend, query, queued.signal)
    const firstRejected = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    })
    const secondRejected = expect(second).rejects.toMatchObject({
      name: 'AbortError',
    })
    queued.abort()
    active.abort()
    await Promise.all([firstRejected, secondRejected])

    expect(await reader.aggregate(backend, query)).toEqual([
      { label: 'example.com', upload: 5, download: 10, count: 1 },
    ])
    store.insertLogs(backend, [log])
    expect(
      await reader.aggregate(backend, {
        ...query,
        groupBy: 'time',
        bucketMs: 1000,
      }),
    ).toEqual([{ label: 1000, upload: 10, download: 20, count: 2 }])
    await expect(
      reader.aggregate(backend, { ...query, groupBy: 'time' }),
    ).rejects.toThrow('bucketMs')
    store.clearBackend(backend)
    expect(await reader.aggregate(backend, query)).toEqual([])
    reader.close()
    await expect(reader.aggregate(backend, query)).rejects.toThrow('closed')
  } finally {
    reader.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
