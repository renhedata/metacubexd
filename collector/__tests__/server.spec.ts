import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Store } from '../store'
import type { DataUsageLog } from '../types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from '../server'
import { createStore } from '../store'

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
  let server: Server
  let base: string

  const start = async (
    token = '',
    onConnect?: (apiURL: string, secret: string) => void,
  ): Promise<void> => {
    server = createServer({
      store,
      token,
      allowedOrigin: '*',
      startedAt: 1000,
      onConnect,
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}`
  }

  beforeEach(() => {
    store = createStore(':memory:')
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
  })

  it('gET /api/health returns ok with row count (no auth required)', async () => {
    store.insertLogs([makeLog()])
    await start('secret')
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, since: 1000, count: 1 })
  })

  it('gET /api/logs returns rows in range with CORS header', async () => {
    store.insertLogs([makeLog({ host: 'a.com' }), makeLog({ host: 'b.com' })])
    await start()
    const res = await fetch(`${base}/api/logs?start=0&end=100000`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const rows = (await res.json()) as DataUsageLog[]
    expect(rows.map((r) => r.host)).toEqual(['a.com', 'b.com'])
  })

  it('rejects /api/logs without a valid bearer token', async () => {
    await start('secret')
    const res = await fetch(`${base}/api/logs?start=0&end=1`)
    expect(res.status).toBe(401)
  })

  it('rejects /api/logs with a wrong bearer token', async () => {
    await start('secret')
    const res = await fetch(`${base}/api/logs?start=0&end=1`, {
      headers: { Authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('accepts /api/logs with the correct bearer token', async () => {
    await start('secret')
    const res = await fetch(`${base}/api/logs?start=0&end=1`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
  })

  it('dELETE /api/logs clears the store', async () => {
    store.insertLogs([makeLog()])
    await start()
    const res = await fetch(`${base}/api/logs`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(store.count()).toBe(0)
  })

  it('pOST /api/connect forwards url and secret to onConnect', async () => {
    const calls: [string, string][] = []
    await start('', (apiURL, secret) => calls.push([apiURL, secret]))
    const res = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9090', secret: 's3cr3t' }),
    })
    expect(res.status).toBe(200)
    expect(calls).toEqual([['http://127.0.0.1:9090', 's3cr3t']])
  })

  it('pOST /api/connect rejects a missing url', async () => {
    await start()
    const res = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown routes', async () => {
    await start()
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
  })
})
