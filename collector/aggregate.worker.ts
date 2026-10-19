import type { AggregateQuery } from './types'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { aggregateLogs } from './store'

const db = new DatabaseSync(workerData as string, { readOnly: true })
parentPort!.on(
  'message',
  ({ backend, query }: { backend: string; query: AggregateQuery }) => {
    try {
      parentPort!.postMessage({ rows: aggregateLogs(db, backend, query) })
    } catch (error) {
      parentPort!.postMessage({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
)
parentPort!.on('close', () => db.close())
