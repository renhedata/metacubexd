import type {
  AggregateQuery,
  AggregateRow,
  DataUsageLog,
  Dimension,
} from './types'
import { DatabaseSync } from 'node:sqlite'
import { DIMENSIONS } from './types'

export interface BackendRow {
  url: string
  secret: string
  addedAt: number
}

export interface Store {
  insertLogs: (backend: string, logs: DataUsageLog[]) => void
  query: (backend: string, start: number, end: number) => DataUsageLog[]
  aggregate: (backend: string, query: AggregateQuery) => AggregateRow[]
  clearBackend: (backend: string) => void
  upsertBackend: (url: string, secret: string) => void
  removeBackend: (backend: string) => void
  listBackends: () => BackendRow[]
  countByBackend: (backend: string) => number
  count: () => number
  cleanup: (before: number) => void
  close: () => void
}

export function createStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS data_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      sourceIP TEXT NOT NULL,
      host TEXT NOT NULL,
      outbound TEXT NOT NULL,
      process TEXT NOT NULL,
      inboundUser TEXT NOT NULL,
      upload INTEGER NOT NULL,
      download INTEGER NOT NULL,
      backend TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS backends (
      url TEXT PRIMARY KEY,
      secret TEXT NOT NULL,
      addedAt INTEGER NOT NULL
    );
  `)

  // v1 databases predate the backend column; legacy rows keep backend='' —
  // invisible to per-backend queries, intentionally preserved.
  const cols = db.prepare('PRAGMA table_info(data_usage_logs)').all() as {
    name: string
  }[]
  if (!cols.some((c) => c.name === 'backend')) {
    db.exec(
      "ALTER TABLE data_usage_logs ADD COLUMN backend TEXT NOT NULL DEFAULT ''",
    )
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_timestamp;
    CREATE INDEX IF NOT EXISTS idx_backend_timestamp
      ON data_usage_logs (backend, timestamp);
  `)

  const insertStmt = db.prepare(
    `INSERT INTO data_usage_logs
       (backend, timestamp, sourceIP, host, outbound, process, inboundUser, upload, download)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const queryStmt = db.prepare(
    `SELECT id, timestamp, sourceIP, host, outbound, process, inboundUser, upload, download
       FROM data_usage_logs
      WHERE backend = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC`,
  )
  const clearBackendStmt = db.prepare(
    'DELETE FROM data_usage_logs WHERE backend = ?',
  )
  const upsertBackendStmt = db.prepare(
    `INSERT INTO backends (url, secret, addedAt) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET secret = excluded.secret`,
  )
  const removeBackendStmt = db.prepare('DELETE FROM backends WHERE url = ?')
  const listBackendsStmt = db.prepare(
    'SELECT url, secret, addedAt FROM backends ORDER BY addedAt ASC, url ASC',
  )
  const countByBackendStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM data_usage_logs WHERE backend = ?',
  )
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM data_usage_logs')
  const cleanupStmt = db.prepare(
    'DELETE FROM data_usage_logs WHERE timestamp < ?',
  )

  return {
    insertLogs(backend, logs) {
      if (logs.length === 0) return
      db.exec('BEGIN')
      try {
        for (const l of logs) {
          insertStmt.run(
            backend,
            l.timestamp,
            l.sourceIP,
            l.host,
            l.outbound,
            l.process,
            l.inboundUser,
            l.upload,
            l.download,
          )
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    query(backend, start, end) {
      return queryStmt.all(backend, start, end) as unknown as DataUsageLog[]
    },
    aggregate(backend, query) {
      const { start, end, groupBy, filters = {}, bucketMs } = query

      const where = ['backend = ?', 'timestamp >= ?', 'timestamp <= ?']
      const whereParams: (string | number)[] = [backend, start, end]
      for (const dim of DIMENSIONS) {
        const v = filters[dim as Dimension]
        if (v !== undefined) {
          where.push(`${dim} = ?`)
          whereParams.push(v)
        }
      }
      const whereSql = where.join(' AND ')

      if (groupBy === 'time') {
        if (!bucketMs || bucketMs <= 0) {
          throw new Error('bucketMs is required for time grouping')
        }
        const sql = `SELECT CAST(timestamp / ? AS INTEGER) * ? AS label,
                            SUM(upload) AS upload, SUM(download) AS download, COUNT(*) AS count
                       FROM data_usage_logs
                      WHERE ${whereSql}
                      GROUP BY CAST(timestamp / ? AS INTEGER)
                      ORDER BY label ASC`
        return db
          .prepare(sql)
          .all(
            bucketMs,
            bucketMs,
            ...whereParams,
            bucketMs,
          ) as unknown as AggregateRow[]
      }

      if (!DIMENSIONS.includes(groupBy as Dimension)) {
        throw new Error(`invalid groupBy: ${groupBy}`)
      }
      const sql = `SELECT ${groupBy} AS label,
                          SUM(upload) AS upload, SUM(download) AS download, COUNT(*) AS count
                     FROM data_usage_logs
                    WHERE ${whereSql}
                    GROUP BY ${groupBy}`
      return db.prepare(sql).all(...whereParams) as unknown as AggregateRow[]
    },
    clearBackend(backend) {
      clearBackendStmt.run(backend)
    },
    upsertBackend(url, secret) {
      upsertBackendStmt.run(url, secret, Date.now())
    },
    removeBackend(backend) {
      clearBackendStmt.run(backend)
      removeBackendStmt.run(backend)
    },
    listBackends() {
      return listBackendsStmt.all() as unknown as BackendRow[]
    },
    countByBackend(backend) {
      const row = countByBackendStmt.get(backend) as { n: number }
      return row.n
    },
    count() {
      const row = countStmt.get() as { n: number }
      return row.n
    },
    cleanup(before) {
      cleanupStmt.run(before)
    },
    close() {
      db.close()
    },
  }
}
