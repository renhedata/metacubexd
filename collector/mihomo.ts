const RECONNECT_DELAY = 3000

export interface MihomoClientOptions {
  wsURL: string
  secret: string
  onMessage: (msg: unknown) => void
  log?: (msg: string) => void
}

export interface MihomoClient {
  close: () => void
}

export function connectMihomo(opts: MihomoClientOptions): MihomoClient {
  const log = opts.log ?? (() => {})
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const buildURL = (): string => {
    const params = new URLSearchParams()
    if (opts.secret) params.set('token', opts.secret)
    return `${opts.wsURL}/connections?${params.toString()}`
  }

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open()
    }, RECONNECT_DELAY)
  }

  const open = (): void => {
    if (closed) return
    ws = new WebSocket(buildURL())
    ws.onmessage = (event: MessageEvent) => {
      try {
        opts.onMessage(JSON.parse(event.data as string))
      } catch {
        // ignore parse errors
      }
    }
    ws.onerror = () => log('mihomo websocket error')
    ws.onclose = () => {
      if (closed) return
      log('mihomo websocket closed, reconnecting')
      scheduleReconnect()
    }
  }

  open()

  return {
    close() {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        ws.onclose = null
        ws.close()
        ws = null
      }
    },
  }
}
