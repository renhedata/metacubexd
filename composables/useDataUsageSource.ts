// composables/useDataUsageSource.ts
import type { DataUsageLog } from '~/utils/db'
import { z } from 'zod'
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

  // When no explicit URL is set, talk to the bundled collector through this
  // dashboard's own server (same-origin /__collector proxy) — zero config. A
  // non-empty value points at a collector running elsewhere.
  const collectorBase = (): string =>
    configStore.collectorURL.replace(/\/$/, '') || '/__collector'

  const queryCollector = async (
    start: number,
    end: number,
  ): Promise<DataUsageLog[]> => {
    const res = await fetch(
      `${collectorBase()}/api/logs?start=${start}&end=${end}`,
      {
        headers: authHeaders(),
      },
    )
    if (!res.ok) {
      throw new Error(`Collector request failed with status ${res.status}`)
    }
    return dataUsageLogsSchema.parse(await res.json())
  }

  const query = (start: number, end: number): Promise<DataUsageLog[]> =>
    configStore.enableBackgroundCollector
      ? queryCollector(start, end)
      : db.query(start, end)

  const clearCollectorData = async (): Promise<void> => {
    const res = await fetch(`${collectorBase()}/api/logs`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (!res.ok) {
      throw new Error(`Collector clear failed with status ${res.status}`)
    }
  }

  // Push the dashboard's current mihomo endpoint to the collector so it connects
  // to the same backend without the user entering the mihomo URL/secret manually.
  const configureCollector = async (): Promise<void> => {
    const endpoint = endpointStore.currentEndpoint
    if (!endpoint) return
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
