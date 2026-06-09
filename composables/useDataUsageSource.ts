// composables/useDataUsageSource.ts
import type { DataUsageLog } from '~/utils/db'
import { z } from 'zod'
import { db } from '~/utils/db'

export interface DataUsageSource {
  query: (start: number, end: number) => Promise<DataUsageLog[]>
  clearCollectorData: () => Promise<void>
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

  const authHeaders = (): Record<string, string> =>
    configStore.collectorToken
      ? { Authorization: `Bearer ${configStore.collectorToken}` }
      : {}

  const collectorBase = (): string => {
    const url = configStore.collectorURL.replace(/\/$/, '')
    if (!url) {
      throw new Error(
        'Background collector is enabled but Collector URL is not set',
      )
    }
    return url
  }

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

  return { query, clearCollectorData }
}
