import type { ConnectionsMessage, RawConnection } from '../types'
import { describe, expect, it } from 'vitest'
import { createTracker } from '../tracker'

const conn = (over: Partial<RawConnection> = {}): RawConnection => ({
  id: 'c1',
  upload: 0,
  download: 0,
  chains: ['PROXY'],
  metadata: {
    sourceIP: '10.0.0.1',
    host: 'example.com',
    process: 'curl',
    inboundUser: 'user1',
  },
  ...over,
})

const msg = (
  connections: RawConnection[],
  uploadTotal = 0,
  downloadTotal = 0,
): ConnectionsMessage => ({ connections, uploadTotal, downloadTotal })

describe('collector/tracker', () => {
  it('emits no delta on the first observation of a connection (baseline-only)', () => {
    const t = createTracker(() => 60000)
    t.processMessage(msg([conn({ upload: 500, download: 900 })], 500, 900))
    expect(t.drainBuffer()).toEqual([])
  })

  it('emits the delta from the second observation onward', () => {
    const t = createTracker(() => 60000)
    t.processMessage(msg([conn({ upload: 500, download: 900 })], 500, 900))
    t.processMessage(msg([conn({ upload: 700, download: 1500 })], 700, 1500))

    const logs = t.drainBuffer()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      timestamp: 60000,
      sourceIP: '10.0.0.1',
      host: 'example.com',
      outbound: 'PROXY',
      process: 'curl',
      inboundUser: 'user1',
      upload: 200,
      download: 600,
    })
  })

  it('aggregates deltas within the same minute bucket by composite key', () => {
    const now = 60000
    const t = createTracker(() => now)
    t.processMessage(msg([conn({ upload: 0, download: 0 })]))
    t.processMessage(msg([conn({ upload: 100, download: 100 })]))
    t.processMessage(msg([conn({ upload: 250, download: 100 })]))

    const logs = t.drainBuffer()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ upload: 250, download: 100 })
  })

  it('resets per-connection baseline on core restart but keeps no record of it', () => {
    const t = createTracker(() => 60000)
    // Establish baseline + one delta.
    t.processMessage(msg([conn({ upload: 100, download: 100 })], 100, 100))
    t.processMessage(msg([conn({ upload: 300, download: 300 })], 300, 300))
    t.drainBuffer()

    // Core restarts: totals drop. Same connection id now reports low cumulative.
    t.processMessage(msg([conn({ upload: 50, download: 50 })], 50, 50))
    // First post-restart sample is baseline-only -> no delta.
    expect(t.drainBuffer()).toEqual([])

    // Next sample emits the delta from the new baseline (not 50 -> would be
    // negative; clamps to a real delta from 50).
    t.processMessage(msg([conn({ upload: 120, download: 90 })], 120, 90))
    expect(t.drainBuffer()[0]).toMatchObject({ upload: 70, download: 40 })
  })

  it('clamps negative deltas to zero', () => {
    const t = createTracker(() => 60000)
    t.processMessage(msg([conn({ upload: 100, download: 100 })], 100, 100))
    // Same totals (no restart), but this connection's counter went backwards.
    t.processMessage(msg([conn({ upload: 80, download: 130 })], 100, 100))
    const logs = t.drainBuffer()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ upload: 0, download: 30 })
  })

  it('falls back through metadata fields for label values', () => {
    const t = createTracker(() => 60000)
    const bare = conn({
      id: 'c2',
      chains: [],
      metadata: { destinationIP: '1.2.3.4', type: 'TCP' },
    })
    t.processMessage(msg([{ ...bare, upload: 0, download: 0 }]))
    t.processMessage(msg([{ ...bare, upload: 10, download: 0 }]))
    const logs = t.drainBuffer()
    expect(logs[0]).toMatchObject({
      sourceIP: 'Inner',
      host: '1.2.3.4',
      process: 'Unknown',
      outbound: 'DIRECT',
      inboundUser: 'TCP',
    })
  })

  it('drainBuffer empties the buffer', () => {
    const t = createTracker(() => 60000)
    t.processMessage(msg([conn({ upload: 0, download: 0 })]))
    t.processMessage(msg([conn({ upload: 10, download: 10 })]))
    expect(t.drainBuffer()).toHaveLength(1)
    expect(t.drainBuffer()).toEqual([])
  })
})
