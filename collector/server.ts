import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { BackendManager } from './backends'
import type { Store } from './store'
import { createServer as createHttpServer } from 'node:http'
import { normalizeBackend } from './backends'

export interface ServerOptions {
  store: Store
  manager: BackendManager
  token: string
  allowedOrigin: string
  startedAt: number
}

export function createServer(opts: ServerOptions): Server {
  const { store, manager, token, allowedOrigin, startedAt } = opts

  const setCors = (res: ServerResponse): void => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  }

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
      })
      req.on('end', () => resolve(data))
      req.on('error', () => resolve(''))
    })

  const isAuthorized = (req: IncomingMessage): boolean =>
    (req.headers.authorization ?? '') === `Bearer ${token}`

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  // Returns the normalized backend from a query param, or null (caller sends 400).
  const backendParam = (url: URL, name: string): string | null => {
    const raw = url.searchParams.get(name)
    if (!raw) return null
    try {
      return normalizeBackend(raw)
    } catch {
      return null
    }
  }

  return createHttpServer(async (req, res) => {
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

      if (req.method === 'POST' && url.pathname === '/api/connect') {
        let parsed: { url?: unknown; secret?: unknown }
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          json(res, 400, { error: 'invalid json' })
          return
        }
        if (typeof parsed.url !== 'string' || !parsed.url) {
          json(res, 400, { error: 'url is required' })
          return
        }
        const secret = typeof parsed.secret === 'string' ? parsed.secret : ''
        try {
          manager.upsert(parsed.url, secret)
        } catch {
          json(res, 400, { error: 'invalid url' })
          return
        }
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const backend = backendParam(url, 'backend')
        if (!backend) {
          json(res, 400, { error: 'backend is required' })
          return
        }
        const start = Number(url.searchParams.get('start')) || 0
        const endParam = Number(url.searchParams.get('end'))
        const end =
          Number.isFinite(endParam) && endParam > 0 ? endParam : Date.now()
        json(res, 200, store.query(backend, start, end))
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/api/logs') {
        const backend = backendParam(url, 'backend')
        if (!backend) {
          json(res, 400, { error: 'backend is required' })
          return
        }
        store.clearBackend(backend)
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/backends') {
        json(res, 200, manager.list())
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/api/backends') {
        const backend = backendParam(url, 'url')
        if (!backend) {
          json(res, 400, { error: 'url is required' })
          return
        }
        manager.remove(backend)
        json(res, 200, { ok: true })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch {
      json(res, 500, { error: 'internal error' })
    }
  })
}
