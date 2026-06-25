export interface CollectorConfig {
  mihomoApiURL: string
  mihomoSecret: string
  port: number
  dbPath: string
  retentionMs: number
  token: string
  allowedOrigin: string
}

export function toWsURL(httpURL: string): string {
  return new URL(httpURL).href.replace(/^http/, 'ws').replace(/\/$/, '')
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): CollectorConfig {
  // The collector is meant to be exposed through a public domain (reverse
  // proxy), so running without an API key is never acceptable.
  const token = env.COLLECTOR_TOKEN ?? ''
  if (!token) {
    throw new Error(
      'COLLECTOR_TOKEN is required (set it to the API key the dashboard will use)',
    )
  }

  // MIHOMO_API_URL is an optional seed backend: more backends register at
  // runtime via POST /api/connect and persist in the database.
  const mihomoApiURL = env.MIHOMO_API_URL ?? ''
  if (mihomoApiURL) {
    try {
      void new URL(mihomoApiURL)
    } catch {
      throw new Error(`MIHOMO_API_URL is not a valid URL: ${mihomoApiURL}`)
    }
  }

  return {
    mihomoApiURL,
    mihomoSecret: env.MIHOMO_SECRET ?? '',
    port: Number(env.PORT ?? 9797),
    dbPath: env.DB_PATH ?? './collector-data.sqlite',
    retentionMs: Number(env.RETENTION_MS ?? 0),
    token,
    allowedOrigin: env.ALLOWED_ORIGIN ?? '*',
  }
}
