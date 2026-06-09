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

vi.stubGlobal('useConfigStore', () => configStore)

beforeEach(() => {
  vi.clearAllMocks()
  configStore.enableBackgroundCollector = false
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
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const { clearCollectorData } = useDataUsageSource()
    await clearCollectorData()

    expect(fetchMock).toHaveBeenCalledWith('http://collector:9797/api/logs', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok' },
    })
  })
})
