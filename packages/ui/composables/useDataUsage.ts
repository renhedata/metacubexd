import type { AggregateRow, DataUsageType } from '~/types'
import { useDataUsageSource } from '~/composables/useDataUsageSource'

export interface AggregatedData {
  label: string
  upload: number
  download: number
  total: number
  count: number
  // What the label represents (e.g. 'sourceIP', 'host'), used by renderers for
  // kind-specific display transforms (e.g. reverse-DNS of client IPs).
  kind: DataUsageType
}

const toAggregated = (
  rows: AggregateRow[],
  kind: DataUsageType,
): AggregatedData[] =>
  rows.map((r) => ({
    label: String(r.label),
    kind,
    upload: r.upload,
    download: r.download,
    total: r.upload + r.download,
    count: r.count,
  }))

const byTotalDesc = (a: AggregatedData, b: AggregatedData) => b.total - a.total

export const useDataUsage = () => {
  const source = useDataUsageSource()

  const getAggregatedData = async (
    type: DataUsageType,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({ start: startTime, end: endTime, groupBy: type }),
      type,
    )

  const getSubStatsByHost = async (
    dimension: Exclude<DataUsageType, 'host'>,
    label: string,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({
        start: startTime,
        end: endTime,
        groupBy: 'host',
        filters: { [dimension]: label },
      }),
      'host',
    ).sort(byTotalDesc)

  const getProxyStatsByHost = async (
    dimension: Exclude<DataUsageType, 'host' | 'outbound'>,
    parentLabel: string,
    host: string,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({
        start: startTime,
        end: endTime,
        groupBy: 'outbound',
        filters: { host, [dimension]: parentLabel },
      }),
      'outbound',
    ).sort(byTotalDesc)

  const getDevicesByHost = async (
    host: string,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({
        start: startTime,
        end: endTime,
        groupBy: 'sourceIP',
        filters: { host },
      }),
      'sourceIP',
    ).sort(byTotalDesc)

  const getDevicesByProxyAndHost = async (
    proxy: string,
    host: string,
    startTime: number,
    endTime: number,
  ): Promise<AggregatedData[]> =>
    toAggregated(
      await source.aggregate({
        start: startTime,
        end: endTime,
        groupBy: 'sourceIP',
        filters: { outbound: proxy, host },
      }),
      'sourceIP',
    ).sort(byTotalDesc)

  const getTrafficTrend = async (
    startTime: number,
    endTime: number,
    bucketSizeMs: number,
  ): Promise<{ timestamp: number; upload: number; download: number }[]> => {
    const rows = await source.aggregate({
      start: startTime,
      end: endTime,
      groupBy: 'time',
      bucketMs: bucketSizeMs,
    })

    const buckets = new Map<number, { upload: number; download: number }>()
    for (let t = startTime; t <= endTime; t += bucketSizeMs) {
      const bucketStart = Math.floor(t / bucketSizeMs) * bucketSizeMs
      buckets.set(bucketStart, { upload: 0, download: 0 })
    }
    rows.forEach((r) => {
      const bucketStart = Number(r.label)
      const bucket = buckets.get(bucketStart)
      if (bucket) {
        bucket.upload += r.upload
        bucket.download += r.download
      }
    })

    return Array.from(buckets.entries())
      .map(([timestamp, data]) => ({ timestamp, ...data }))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  return {
    getAggregatedData,
    getSubStatsByHost,
    getProxyStatsByHost,
    getDevicesByHost,
    getDevicesByProxyAndHost,
    getTrafficTrend,
  }
}
