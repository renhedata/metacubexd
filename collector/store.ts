import type { DataUsageLog } from './types'
import { DatabaseSync } from 'node:sqlite'

export interface Store {
  insertLogs: (logs: DataUsageLog[]) => void
  query: (start: number, end: number) => DataUsageLog[]
  cleanup: (before: number) => void
  clearAll: () => void
  count: () => number
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
      download INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON data_usage_logs (timestamp);
  `)

  const insertStmt = db.prepare(
    `INSERT INTO data_usage_logs
       (timestamp, sourceIP, host, outbound, process, inboundUser, upload, download)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const queryStmt = db.prepare(
    `SELECT id, timestamp, sourceIP, host, outbound, process, inboundUser, upload, download
       FROM data_usage_logs
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC`,
  )
  const cleanupStmt = db.prepare(
    'DELETE FROM data_usage_logs WHERE timestamp < ?',
  )
  const clearStmt = db.prepare('DELETE FROM data_usage_logs')
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM data_usage_logs')

  return {
    insertLogs(logs) {
      if (logs.length === 0) return
      db.exec('BEGIN')
      try {
        for (const l of logs) {
          insertStmt.run(
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
    query(start, end) {
      return queryStmt.all(start, end) as unknown as DataUsageLog[]
    },
    cleanup(before) {
      cleanupStmt.run(before)
    },
    clearAll() {
      clearStmt.run()
    },
    count() {
      const row = countStmt.get() as { n: number }
      return row.n
    },
    close() {
      db.close()
    },
  }
}
