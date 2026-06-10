import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BackendManager } from '../backends'
import type { MihomoClientOptions } from '../mihomo'
import type { Store } from '../store'
import type { DataUsageLog } from '../types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackendManager } from '../backends'
import { createServer } from '../server'
import { createStore } from '../store'

const A = 'http://mihomo-a:9090'
const TOKEN = 'secret'
const auth = { Authorization: `Bearer ${TOKEN}` }

const makeLog = (over: Partial<DataUsageLog> = {}): DataUsageLog => ({
  timestamp: 60000,
  sourceIP: '10.0.0.1',
  host: 'example.com',
  outbound: 'PROXY',
  process: 'curl',
  inboundUser: 'Unknown',
  upload: 100,
  download: 200,
  ...over,
})

describe('collector/server', () => {
  let store: Store
  let manager: BackendManager
  let server: Server
  let base: string

  beforeEach(async () => {
    store = createStore(':memory:')
    manager = createBackendManager({
      store,
      connect: (_opts: MihomoClientOptions) => ({ close: () => {} }),
    })
    server = createServer({
      store,
      manager,
      token: TOKEN,
      allowedOrigin: '*',
      startedAt: 1000,
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
  })

  it('serves /api/health without auth', async () => {
    store.insertLogs(A, [makeLog()])
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, since: 1000, count: 1 })
  })

  it('rejects /api/logs without or with a wrong bearer token', async () => {
    expect((await fetch(`${base}/api/logs?backend=${A}`)).status).toBe(401)
    expect(
      (
        await fetch(`${base}/api/logs?backend=${A}`, {
          headers: { Authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401)
  })

  it('serves logs for the requested backend only, with CORS header', async () => {
    store.insertLogs(A, [makeLog({ host: 'a.com' })])
    store.insertLogs('http://other:9090', [makeLog({ host: 'b.com' })])

    const res = await fetch(
      `${base}/api/logs?backend=${encodeURIComponent(`${A}/`)}&start=0&end=100000`,
      { headers: auth },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const rows = (await res.json()) as DataUsageLog[]
    expect(rows.map((r) => r.host)).toEqual(['a.com'])
  })

  it('rejects /api/logs without a backend param', async () => {
    const res = await fetch(`${base}/api/logs?start=0&end=1`, {
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  it('rejects /api/logs with an invalid backend url', async () => {
    const res = await fetch(`${base}/api/logs?backend=not%20a%20url`, {
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  it('dELETE /api/logs clears only the requested backend', async () => {
    store.insertLogs(A, [makeLog()])
    store.insertLogs('http://other:9090', [makeLog()])

    const res = await fetch(
      `${base}/api/logs?backend=${encodeURIComponent(A)}`,
      { method: 'DELETE', headers: auth },
    )

    expect(res.status).toBe(200)
    expect(store.countByBackend(A)).toBe(0)
    expect(store.countByBackend('http://other:9090')).toBe(1)
  })

  it('dELETE /api/logs without a backend param is rejected', async () => {
    const res = await fetch(`${base}/api/logs`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  it('pOST /api/connect upserts the backend into the collection set', async () => {
    const res = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${A}/`, secret: 's3cr3t' }),
    })

    expect(res.status).toBe(200)
    expect(store.listBackends().map((b) => b.url)).toEqual([A])
  })

  it('pOST /api/connect rejects a missing or invalid url', async () => {
    const missing = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'x' }),
    })
    expect(missing.status).toBe(400)

    const invalid = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not a url' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('gET /api/backends lists registrations with status and count', async () => {
    manager.upsert(A, 's')
    store.insertLogs(A, [makeLog()])

    const res = await fetch(`${base}/api/backends`, { headers: auth })

    expect(res.status).toBe(200)
    const rows = (await res.json()) as {
      url: string
      connected: boolean
      count: number
      addedAt: number
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ url: A, connected: true, count: 1 })
  })

  it('dELETE /api/backends removes the backend and its data', async () => {
    manager.upsert(A, 's')
    store.insertLogs(A, [makeLog()])

    const res = await fetch(
      `${base}/api/backends?url=${encodeURIComponent(A)}`,
      { method: 'DELETE', headers: auth },
    )

    expect(res.status).toBe(200)
    expect(store.listBackends()).toEqual([])
    expect(store.countByBackend(A)).toBe(0)
  })

  it('dELETE /api/backends without url is rejected', async () => {
    const res = await fetch(`${base}/api/backends`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${base}/nope`, { headers: auth })
    expect(res.status).toBe(404)
  })
})
