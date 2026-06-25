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
