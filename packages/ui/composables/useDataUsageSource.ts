// composables/useDataUsageSource.ts
import type { AggregateQuery, AggregateRow } from '~/types'
import { z } from 'zod'
import { normalizeBackend } from '~/utils/collector'

export interface DataUsageSource {
  aggregate: (query: AggregateQuery) => Promise<AggregateRow[]>
  clearCollectorData: () => Promise<void>
  configureCollector: () => Promise<void>
  ready: () => boolean
}

const aggregateRowSchema = z.object({
  label: z.union([z.string(), z.number()]),
  upload: z.number(),
  download: z.number(),
  count: z.number(),
})
const aggregateRowsSchema = z.array(aggregateRowSchema)

const FILTER_PARAMS: Record<string, string> = {
  sourceIP: 'fSourceIP',
  host: 'fHost',
  outbound: 'fOutbound',
  process: 'fProcess',
  inboundUser: 'fInboundUser',
}

export function useDataUsageSource(): DataUsageSource {
  const configStore = useConfigStore()
  const endpointStore = useEndpointStore()

  const authHeaders = (): Record<string, string> =>
    configStore.collectorToken
      ? { Authorization: `Bearer ${configStore.collectorToken}` }
      : {}

  const collectorBase = (): string =>
    configStore.collectorURL.replace(/\/$/, '')

  // The collector partitions data per mihomo backend; every call is scoped to
  // the dashboard's currently selected endpoint.
  const currentBackend = (): string => {
    const endpoint = endpointStore.currentEndpoint
    if (!endpoint) return ''
    try {
      return normalizeBackend(endpoint.url)
    } catch {
      return ''
    }
  }

  const ready = (): boolean =>
    Boolean(configStore.enableBackgroundCollector) &&
    collectorBase() !== '' &&
    currentBackend() !== ''

  const aggregate = async (query: AggregateQuery): Promise<AggregateRow[]> => {
    if (!ready()) return []

    const params = new URLSearchParams()
    params.set('backend', currentBackend())
    params.set('start', String(query.start))
    params.set('end', String(query.end))
    params.set('groupBy', query.groupBy)
    if (query.bucketMs) params.set('bucket', String(query.bucketMs))
    for (const [dim, value] of Object.entries(query.filters ?? {})) {
      if (value !== undefined) params.set(FILTER_PARAMS[dim]!, value)
    }

    const res = await fetch(`${collectorBase()}/api/aggregate?${params}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      throw new Error(`Collector request failed with status ${res.status}`)
    }
    return aggregateRowsSchema.parse(await res.json())
  }

  const clearCollectorData = async (): Promise<void> => {
    if (!ready()) {
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

  return { aggregate, clearCollectorData, configureCollector, ready }
}
