import type { ConnectionsMessage } from './types'
import { loadConfig } from './config'
// collector/index.ts
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

  const client = connectMihomo({
    wsURL: config.mihomoWsURL,
    secret: config.mihomoSecret,
    onMessage: (msg) => tracker.processMessage(msg as ConnectionsMessage),
    log: (m) => console.log(`[collector] ${m}`),
  })

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
  })
  server.listen(config.port, () => {
    console.log(
      `[collector] listening on :${config.port} db=${config.dbPath} mihomo=${config.mihomoWsURL}`,
    )
  })

  const shutdown = (): void => {
    clearInterval(flushTimer)
    flush()
    client.close()
    server.close()
    store.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
