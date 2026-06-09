import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Store } from './store'
import { createServer as createHttpServer } from 'node:http'

export interface ServerOptions {
  store: Store
  token: string
  allowedOrigin: string
  startedAt: number
}

export function createServer(opts: ServerOptions): Server {
  const { store, token, allowedOrigin, startedAt } = opts

  const setCors = (res: ServerResponse): void => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  }

  const isAuthorized = (req: IncomingMessage): boolean => {
    if (!token) return true
    return (req.headers.authorization ?? '') === `Bearer ${token}`
  }

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  return createHttpServer((req, res) => {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')

    try {
      // Health is public so the dashboard can probe reachability without a token.
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, { ok: true, since: startedAt, count: store.count() })
        return
      }

      if (!isAuthorized(req)) {
        json(res, 401, { error: 'unauthorized' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const start = Number(url.searchParams.get('start')) || 0
        const endParam = Number(url.searchParams.get('end'))
        const end =
          Number.isFinite(endParam) && endParam > 0 ? endParam : Date.now()
        json(res, 200, store.query(start, end))
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/api/logs') {
        store.clearAll()
        json(res, 200, { ok: true })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch {
      json(res, 500, { error: 'internal error' })
    }
  })
}
