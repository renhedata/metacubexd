import type { MihomoClient } from './mihomo'
import type { ConnectionsMessage } from './types'
import { loadConfig, toWsURL } from './config'
import { connectMihomo } from './mihomo'
import { createServer } from './server'
import { createStore } from './store'
import { createTracker } from './tracker'

const FLUSH_INTERVAL_MS = 30000

function main(): void {
  const config = loadConfig()
  const store = createStore(config.dbPath)
  const tracker = createTracker()
  const startedAt = Date.now()
  const log = (m: string): void => console.log(`[collector] ${m}`)

  // The mihomo connection is reconfigurable at runtime: the dashboard pushes its
  // current endpoint via POST /api/connect, so the daemon needs no manual mihomo
  // env config. `currentTarget` dedupes redundant reconnects.
  let client: MihomoClient | null = null
  let currentTarget = ''

  const connectTo = (apiURL: string, secret: string): void => {
    let wsURL = ''
    try {
      wsURL = toWsURL(apiURL)
    } catch {
      log(`ignoring invalid mihomo url: ${apiURL}`)
      return
    }
    const target = `${wsURL}\x1F${secret}`
    if (client && target === currentTarget) return
    currentTarget = target
    client?.close()
    client = connectMihomo({
      wsURL,
      secret,
      onMessage: (msg) => tracker.processMessage(msg as ConnectionsMessage),
      log,
    })
    log(`connecting to mihomo ${wsURL}`)
  }

  if (config.mihomoApiURL) connectTo(config.mihomoApiURL, config.mihomoSecret)

  const flush = (): void => {
    const logs = tracker.drainBuffer()
    if (logs.length === 0) return
    store.insertLogs(logs)
    if (config.retentionMs > 0) {
      store.cleanup(Date.now() - config.retentionMs)
    }
  }

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)

  const server = createServer({
    store,
    token: config.token,
    allowedOrigin: config.allowedOrigin,
    startedAt,
    onConnect: connectTo,
  })
  server.listen(config.port, () => {
    log(`listening on :${config.port} db=${config.dbPath}`)
  })

  const shutdown = (): void => {
    clearInterval(flushTimer)
    flush()
    client?.close()
    server.close()
    store.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
