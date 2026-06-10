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
