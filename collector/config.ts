export interface CollectorConfig {
  mihomoApiURL: string
  mihomoWsURL: string
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
  const mihomoApiURL = env.MIHOMO_API_URL
  if (!mihomoApiURL) {
    throw new Error('MIHOMO_API_URL is required')
  }

  let mihomoWsURL: string
  try {
    mihomoWsURL = toWsURL(mihomoApiURL)
  } catch {
    throw new Error(`MIHOMO_API_URL is not a valid URL: ${mihomoApiURL}`)
  }

  return {
    mihomoApiURL,
    mihomoWsURL,
    mihomoSecret: env.MIHOMO_SECRET ?? '',
    port: Number(env.PORT ?? 9797),
    dbPath: env.DB_PATH ?? './collector-data.sqlite',
    retentionMs: Number(env.RETENTION_MS ?? 0),
    token: env.COLLECTOR_TOKEN ?? '',
    allowedOrigin: env.ALLOWED_ORIGIN ?? '*',
  }
}
