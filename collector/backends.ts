import type { MihomoClient, MihomoClientOptions } from './mihomo'
import type { Store } from './store'
import type { Tracker } from './tracker'
import type { ConnectionsMessage, DataUsageLog } from './types'
import { toWsURL } from './config'
import { connectMihomo } from './mihomo'
import { createTracker } from './tracker'

// Keep in sync with utils/collector.ts (the frontend mirror).
// Canonical form: scheme + host + path, lowercased host (via WHATWG URL),
// no credentials/query/fragment, no trailing slashes. The path is kept so a
// mihomo controller behind a reverse-proxy path prefix still works.
export function normalizeBackend(raw: string): string {
  const u = new URL(raw)
  u.username = ''
  u.password = ''
  u.search = ''
  u.hash = ''
  return u.href.replace(/\/+$/, '')
}

export interface BackendStatus {
  url: string
  addedAt: number
  connected: boolean
  count: number
}

export interface DrainedLogs {
  backend: string
  logs: DataUsageLog[]
}

export interface BackendManager {
  // Throws TypeError when the url is not parseable (callers map this to 400).
  upsert: (url: string, secret: string) => void
  remove: (url: string) => void
  list: () => BackendStatus[]
  drainAll: () => DrainedLogs[]
  loadPersisted: () => void
  closeAll: () => void
}

export interface BackendManagerOptions {
  store: Store
  log?: (msg: string) => void
  connect?: (opts: MihomoClientOptions) => MihomoClient
}

export function createBackendManager(
  opts: BackendManagerOptions,
): BackendManager {
  const { store } = opts
  const log = opts.log ?? (() => {})
  const connect = opts.connect ?? connectMihomo
  const active = new Map<
    string,
    { client: MihomoClient; tracker: Tracker; secret: string }
  >()

  const open = (url: string, secret: string): void => {
    // One tracker per backend: connection ids and cumulative totals are
    // per-backend state, sharing a tracker would corrupt the deltas.
    const tracker = createTracker()
    const client = connect({
      wsURL: toWsURL(url),
      secret,
      onMessage: (msg) => tracker.processMessage(msg as ConnectionsMessage),
      log: (m) => log(`[${url}] ${m}`),
    })
    active.set(url, { client, tracker, secret })
    log(`collecting from ${url}`)
  }

  return {
    upsert(rawUrl, secret) {
      const url = normalizeBackend(rawUrl)
      store.upsertBackend(url, secret)
      const existing = active.get(url)
      if (existing && existing.secret === secret) return
      if (existing) {
        // Secret rotation replaces client and tracker; persist what the old
        // tracker buffered so up to one flush interval of data is not lost.
        const pending = existing.tracker.drainBuffer()
        if (pending.length > 0) store.insertLogs(url, pending)
        existing.client.close()
      }
      open(url, secret)
    },
    remove(rawUrl) {
      const url = normalizeBackend(rawUrl)
      active.get(url)?.client.close()
      active.delete(url)
      // Buffered deltas are dropped deliberately: removal means "forget this backend".
      store.removeBackend(url)
      log(`removed backend ${url}`)
    },
    list() {
      return store.listBackends().map((b) => ({
        url: b.url,
        addedAt: b.addedAt,
        connected: active.has(b.url),
        count: store.countByBackend(b.url),
      }))
    },
    drainAll() {
      const out: DrainedLogs[] = []
      for (const [backend, { tracker }] of active) {
        const logs = tracker.drainBuffer()
        if (logs.length > 0) out.push({ backend, logs })
      }
      return out
    },
    // Startup-only rehydration: opens registered backends that are not active
    // yet. It does not reconcile secret changes — runtime updates go through
    // upsert().
    loadPersisted() {
      for (const b of store.listBackends()) {
        if (!active.has(b.url)) open(b.url, b.secret)
      }
    },
    closeAll() {
      for (const { client } of active.values()) client.close()
      active.clear()
    },
  }
}
