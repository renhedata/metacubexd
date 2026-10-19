import type { AggregateQuery, AggregateRow } from './types'
import { Worker } from 'node:worker_threads'

export class AggregateBusyError extends Error {}

export interface AggregateReader {
  aggregate: (
    backend: string,
    query: AggregateQuery,
    signal?: AbortSignal,
  ) => Promise<AggregateRow[]>
  close: () => void
}

interface Request {
  backend: string
  query: AggregateQuery
  resolve: (rows: AggregateRow[]) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort: () => void
}

// One query per worker: cancellation terminates the current SQLite read, not
// just its HTTP response. Queued requests stay in the parent and can be removed.
function createQueue(dbPath: string): AggregateReader {
  let worker: Worker | undefined
  let active: Request | undefined
  let closed = false
  const pending: Request[] = []

  const detach = (request: Request) =>
    request.signal?.removeEventListener('abort', request.abort)

  const stopWorker = () => {
    const old = worker
    worker = undefined
    if (old) void old.terminate()
  }

  const fail = (error: Error) => {
    stopWorker()
    const requests = active ? [active, ...pending] : [...pending]
    active = undefined
    pending.length = 0
    for (const request of requests) {
      detach(request)
      request.reject(error)
    }
  }

  const dispatch = () => {
    if (closed || active || pending.length === 0) return
    if (!worker) {
      const source = import.meta.url.endsWith('.ts')
      const url = new URL(
        source ? './aggregate.worker.ts' : './aggregate.worker.mjs',
        import.meta.url,
      )
      // tsx's CLI loader does not register TypeScript in worker entrypoints.
      const current = new Worker(
        source
          ? `import('tsx/esm/api').then(({ register }) => { register(); return import(${JSON.stringify(url.href)}); })`
          : url,
        { eval: source, workerData: dbPath },
      )
      worker = current
      current.on(
        'message',
        (reply: { rows: AggregateRow[] } | { error: string }) => {
          if (worker !== current || !active) return
          const request = active
          active = undefined
          detach(request)
          if ('error' in reply) request.reject(new Error(reply.error))
          else request.resolve(reply.rows)
          dispatch()
        },
      )
      current.on('error', (error) => {
        if (worker === current)
          fail(error instanceof Error ? error : new Error(String(error)))
      })
      current.on('exit', (code) => {
        if (worker === current)
          fail(new Error(`Aggregate worker exited (${code})`))
      })
    }
    active = pending.shift()!
    worker.postMessage({ backend: active.backend, query: active.query })
  }

  return {
    aggregate(backend: string, query: AggregateQuery, signal?: AbortSignal) {
      return new Promise<AggregateRow[]>((resolve, reject) => {
        if (closed) return reject(new Error('Aggregate reader is closed'))
        if (signal?.aborted) return reject(signal.reason)
        if (pending.length >= 32) {
          return reject(new AggregateBusyError('Too many aggregate requests'))
        }
        const request: Request = {
          backend,
          query,
          resolve,
          reject,
          signal,
          abort: () => {
            detach(request)
            if (active === request) {
              active = undefined
              stopWorker()
            } else {
              const index = pending.indexOf(request)
              if (index !== -1) pending.splice(index, 1)
            }
            reject(signal!.reason)
            dispatch()
          },
        }
        signal?.addEventListener('abort', request.abort, { once: true })
        pending.push(request)
        dispatch()
      })
    },
    close() {
      closed = true
      fail(new Error('Aggregate reader is closed'))
    },
  }
}

export function createAggregateReader(dbPath: string): AggregateReader {
  // Keep the small trend query independent of a long dimension/drilldown scan.
  const time = createQueue(dbPath)
  const dimensions = createQueue(dbPath)
  return {
    aggregate(backend: string, query: AggregateQuery, signal?: AbortSignal) {
      return (query.groupBy === 'time' ? time : dimensions).aggregate(
        backend,
        query,
        signal,
      )
    },
    close() {
      time.close()
      dimensions.close()
    },
  }
}
