// composables/__tests__/useDataUsage.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDataUsage } from '../useDataUsage'

const aggregate = vi.fn()
vi.mock('~/composables/useDataUsageSource', () => ({
  useDataUsageSource: () => ({
    aggregate,
    clearCollectorData: vi.fn(),
    configureCollector: vi.fn(),
    ready: () => true,
  }),
}))

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
      {
        label: 'PROXY',
        kind: 'outbound',
        upload: 10,
        download: 20,
        total: 30,
        count: 2,
      },
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

  it('getProxyStatsByHost groups by outbound filtered by host + dimension', async () => {
    const { getProxyStatsByHost } = useDataUsage()
    await getProxyStatsByHost('process', 'curl', 'a.com', 0, 100)

    expect(aggregate).toHaveBeenCalledWith({
      start: 0,
      end: 100,
      groupBy: 'outbound',
      filters: { host: 'a.com', process: 'curl' },
    })
  })

  it('getDevicesByHost groups by sourceIP filtered by host', async () => {
    const { getDevicesByHost } = useDataUsage()
    await getDevicesByHost('a.com', 0, 100)

    expect(aggregate).toHaveBeenCalledWith({
      start: 0,
      end: 100,
      groupBy: 'sourceIP',
      filters: { host: 'a.com' },
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
