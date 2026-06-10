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

  it('rejects malformed collector rows (schema drift guard)', async () => {
    configStore.enableBackgroundCollector = true
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ host: 123 }],
      }),
    )
    const { query } = useDataUsageSource()
    await expect(query(0, 1)).rejects.toThrow()
  })

  it('falls back to IndexedDB when the endpoint URL is malformed', async () => {
    configStore.enableBackgroundCollector = true
    endpointStore.currentEndpoint = {
      id: 'e1',
      url: 'not-a-url',
      secret: '',
    }
    dbQuery.mockResolvedValue([])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { query } = useDataUsageSource()
    await query(0, 1)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(dbQuery).toHaveBeenCalledWith(0, 1)
  })
})
