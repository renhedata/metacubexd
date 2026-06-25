import type { ConnectionsMessage, DataUsageLog } from './types'

export interface Tracker {
  processMessage: (msg: ConnectionsMessage) => void
  drainBuffer: () => DataUsageLog[]
  hasBuffered: () => boolean
}

// \x1F (unit separator) cannot appear in hosts, IPs or process names, so it is
// a safe delimiter for the composite aggregation key (mirrors stores/connections.ts).
const bufferKey = (l: DataUsageLog): string =>
  `${l.timestamp}\x1F${l.sourceIP}\x1F${l.host}\x1F${l.outbound}\x1F${l.process}\x1F${l.inboundUser}`

export function createTracker(now: () => number = Date.now): Tracker {
  const lastData = new Map<string, { upload: number; download: number }>()
  const buffer = new Map<string, DataUsageLog>()
  let lastUploadTotal = 0
  let lastDownloadTotal = 0

  const processMessage = (msg: ConnectionsMessage): void => {
    const up = msg.uploadTotal ?? 0
    const down = msg.downloadTotal ?? 0

    // Core restart: cumulative totals went backwards. Reset the per-connection
    // baseline only — persisted history is intentionally preserved (collector
    // differs from the in-browser tracker here).
    if (up < lastUploadTotal || down < lastDownloadTotal) {
      lastData.clear()
    }
    lastUploadTotal = up
    lastDownloadTotal = down

    const conns = msg.connections
    if (!conns || conns.length === 0) return

    const minuteStart = Math.floor(now() / 60000) * 60000
    const seen = new Set<string>()

    for (const conn of conns) {
      seen.add(conn.id)
      const curUp = conn.upload || 0
      const curDown = conn.download || 0
      const prev = lastData.get(conn.id)
      lastData.set(conn.id, { upload: curUp, download: curDown })

      // Baseline-only on first observation: emit nothing (collector differs
      // from the in-browser tracker, which counts the full cumulative here).
      if (!prev) continue

      const upDelta = Math.max(0, curUp - prev.upload)
      const downDelta = Math.max(0, curDown - prev.download)
      if (upDelta === 0 && downDelta === 0) continue

      const log: DataUsageLog = {
        timestamp: minuteStart,
        sourceIP: conn.metadata.sourceIP || 'Inner',
        host: conn.metadata.host || conn.metadata.destinationIP || '',
        process: conn.metadata.process || 'Unknown',
        outbound: conn.chains[0] ?? 'DIRECT',
        inboundUser:
          conn.metadata.inboundUser ||
          conn.metadata.inboundIP ||
          conn.metadata.inboundName ||
          conn.metadata.type ||
          'Unknown',
        upload: upDelta,
        download: downDelta,
      }

      const key = bufferKey(log)
      const existing = buffer.get(key)
      if (existing) {
        existing.upload += upDelta
        existing.download += downDelta
      } else {
        buffer.set(key, log)
      }
    }

    // Drop tracking state for connections no longer active.
    for (const id of lastData.keys()) {
      if (!seen.has(id)) lastData.delete(id)
    }
  }

  const drainBuffer = (): DataUsageLog[] => {
    const logs = Array.from(buffer.values())
    buffer.clear()
    return logs
  }

  return { processMessage, drainBuffer, hasBuffered: () => buffer.size > 0 }
}
