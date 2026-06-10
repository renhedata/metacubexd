import type { MihomoClient, MihomoClientOptions } from '../mihomo'
import type { Store } from '../store'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBackendManager, normalizeBackend } from '../backends'
import { createStore } from '../store'

const A = 'http://mihomo-a:9090'
const B = 'http://mihomo-b:9090'

interface FakeConn {
  wsURL: string
  secret: string
  closed: boolean
  emit: (msg: unknown) => void
}

const makeFakeConnect = () => {
  const conns: FakeConn[] = []
  const connect = (opts: MihomoClientOptions): MihomoClient => {
    const conn: FakeConn = {
      wsURL: opts.wsURL,
      secret: opts.secret,
      closed: false,
      emit: (msg) => opts.onMessage(msg),
    }
    conns.push(conn)
    return {
      close: () => {
        conn.closed = true
      },
    }
  }
  return { conns, connect }
}

// Two messages: the first only sets the per-connection baseline, the second
// produces a 100-byte upload delta.
const feedDelta = (conn: FakeConn): void => {
  const meta = { sourceIP: '10.0.0.1', host: 'x.com' }
  conn.emit({
    uploadTotal: 100,
    downloadTotal: 0,
    connections: [
      { id: 'c1', upload: 100, download: 0, chains: ['PROXY'], metadata: meta },
    ],
  })
  conn.emit({
    uploadTotal: 200,
    downloadTotal: 0,
    connections: [
      { id: 'c1', upload: 200, download: 0, chains: ['PROXY'], metadata: meta },
    ],
  })
}

describe('collector/backends', () => {
  let store: Store

  beforeEach(() => {
    store = createStore(':memory:')
  })

  it('normalizeBackend lowercases the host and strips the trailing slash', () => {
    expect(normalizeBackend('HTTP://Mihomo-A:9090/')).toBe(
      'http://mihomo-a:9090',
    )
    expect(normalizeBackend('http://h:9090')).toBe('http://h:9090')
    expect(() => normalizeBackend('not a url')).toThrow()
    expect(normalizeBackend('http://user:pass@h:9090/')).toBe('http://h:9090')
    expect(normalizeBackend('http://h:9090/?x=1#frag')).toBe('http://h:9090')
    expect(normalizeBackend('https://example.com/mihomo/')).toBe(
      'https://example.com/mihomo',
    )
  })

  it('upsert connects and persists the backend', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })

    manager.upsert(`${A}/`, 's1')

    expect(conns).toHaveLength(1)
    expect(conns[0]!.wsURL).toBe('ws://mihomo-a:9090')
    expect(conns[0]!.secret).toBe('s1')
    expect(store.listBackends().map((b) => b.url)).toEqual([A])
  })

  it('upsert with the same url and secret is a no-op', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })

    manager.upsert(A, 's1')
    manager.upsert(A, 's1')

    expect(conns).toHaveLength(1)
    expect(conns[0]!.closed).toBe(false)
  })

  it('upsert with a changed secret reconnects', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })

    manager.upsert(A, 's1')
    manager.upsert(A, 's2')

    expect(conns).toHaveLength(2)
    expect(conns[0]!.closed).toBe(true)
    expect(conns[1]!.secret).toBe('s2')
    expect(store.listBackends()[0]!.secret).toBe('s2')
  })

  it('upsert with a changed secret persists buffered deltas first', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, 's1')

    feedDelta(conns[0]!)
    manager.upsert(A, 's2')

    expect(store.countByBackend(A)).toBe(1)
    expect(store.query(A, 0, Date.now())[0]!.upload).toBe(100)
  })

  it('drainAll tags drained logs with their backend', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, '')
    manager.upsert(B, '')

    feedDelta(conns[0]!)

    const drained = manager.drainAll()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.backend).toBe(A)
    expect(drained[0]!.logs[0]!.upload).toBe(100)
  })

  it('remove closes the connection and deletes registration and logs', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, '')
    store.insertLogs(A, [
      {
        timestamp: 1,
        sourceIP: '',
        host: '',
        outbound: '',
        process: '',
        inboundUser: '',
        upload: 1,
        download: 1,
      },
    ])

    manager.remove(A)

    expect(conns[0]!.closed).toBe(true)
    expect(store.listBackends()).toEqual([])
    expect(store.countByBackend(A)).toBe(0)
  })

  it('list reports registration, active flag and per-backend count', () => {
    const { connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, '')
    store.upsertBackend(B, '') // registered but never connected

    const list = manager.list()

    expect(list).toHaveLength(2)
    const a = list.find((x) => x.url === A)!
    const b = list.find((x) => x.url === B)!
    expect(a.connected).toBe(true)
    expect(b.connected).toBe(false)
  })

  it('loadPersisted connects every registered backend once', () => {
    store.upsertBackend(A, 's1')
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(B, 's2')

    manager.loadPersisted()
    manager.loadPersisted()

    expect(conns.map((c) => c.wsURL).sort()).toEqual([
      'ws://mihomo-a:9090',
      'ws://mihomo-b:9090',
    ])
  })

  it('closeAll closes every connection', () => {
    const { conns, connect } = makeFakeConnect()
    const manager = createBackendManager({ store, connect })
    manager.upsert(A, '')
    manager.upsert(B, '')

    manager.closeAll()

    expect(conns.every((c) => c.closed)).toBe(true)
  })
})
