// collector/types.ts

// DataUsageLog is the collector's own row shape for stored connection deltas.
export interface DataUsageLog {
  id?: number
  timestamp: number
  sourceIP: string
  host: string
  outbound: string
  process: string
  inboundUser: string
  upload: number
  download: number
}

export interface RawConnectionMetadata {
  host?: string
  destinationIP?: string
  sourceIP?: string
  process?: string
  inboundUser?: string
  inboundIP?: string
  inboundName?: string
  type?: string
}

export interface RawConnection {
  id: string
  upload: number
  download: number
  chains: string[]
  metadata: RawConnectionMetadata
}

export interface ConnectionsMessage {
  connections?: RawConnection[]
  uploadTotal?: number
  downloadTotal?: number
}

export const DIMENSIONS = [
  'sourceIP',
  'host',
  'outbound',
  'process',
  'inboundUser',
] as const

export type Dimension = (typeof DIMENSIONS)[number]
export type GroupBy = Dimension | 'time'

export interface AggregateQuery {
  start: number
  end: number
  groupBy: GroupBy
  filters?: Partial<Record<Dimension, string>>
  bucketMs?: number
}

export interface AggregateRow {
  label: string | number
  upload: number
  download: number
  count: number
}
