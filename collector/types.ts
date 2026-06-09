// collector/types.ts

// Mirrors DataUsageLog in ~/utils/db.ts so the HTTP API is shape-compatible
// with what the frontend's useDataUsage aggregation expects.
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
