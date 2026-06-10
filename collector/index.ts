import type { CollectorConfig } from './config'
import { createBackendManager } from './backends'
import { loadConfig } from './config'
import { createServer } from './server'
import { createStore } from './store'

const FLUSH_INTERVAL_MS = 30000

function main(): void {
  let config: CollectorConfig
  try {
    config = loadConfig()
  } catch (e) {
    console.error(`[collector] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  const store = createStore(config.dbPath)
  const log = (m: string): void => console.log(`[collector] ${m}`)
  const manager = createBackendManager({ store, log })
  const startedAt = Date.now()

  // Optional seed backend from env; runtime registrations arrive via
  // POST /api/connect and persist in the backends table.
  if (config.mihomoApiURL) {
    manager.upsert(config.mihomoApiURL, config.mihomoSecret)
  }
  manager.loadPersisted()

  const flush = (): void => {
    try {
      for (const { backend, logs } of manager.drainAll()) {
        store.insertLogs(backend, logs)
      }
      if (config.retentionMs > 0) {
        store.cleanup(Date.now() - config.retentionMs)
      }
    } catch (e) {
      log(
        `flush error (data may be lost): ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)

  const server = createServer({
    store,
    manager,
    token: config.token,
    allowedOrigin: config.allowedOrigin,
    startedAt,
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[collector] server error: ${err.message}`)
    process.exit(1)
  })

  server.listen(config.port, () => {
    log(`listening on :${config.port} db=${config.dbPath}`)
  })

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(flushTimer)
    flush()
    manager.closeAll()
    server.close()
    store.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
