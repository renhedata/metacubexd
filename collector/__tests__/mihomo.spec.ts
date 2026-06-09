import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectMihomo } from '../mihomo'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  close = vi.fn()
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
}

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Re-stub localStorage if it got destroyed so the global setup can use it next
  if (typeof localStorage === 'undefined') {
    let store: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        store = {}
      },
      get length() {
        return Object.keys(store).length
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
    })
  }
})

describe('collector/mihomo', () => {
  it('connects to /connections with the secret as a token query param', () => {
    connectMihomo({ wsURL: 'ws://h:9090', secret: 'abc', onMessage: () => {} })
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]!.url).toBe(
      'ws://h:9090/connections?token=abc',
    )
  })

  it('parses incoming JSON and forwards it to onMessage', () => {
    const onMessage = vi.fn()
    connectMihomo({ wsURL: 'ws://h:9090', secret: '', onMessage })
    MockWebSocket.instances[0]!.onmessage!({ data: '{"uploadTotal":5}' })
    expect(onMessage).toHaveBeenCalledWith({ uploadTotal: 5 })
  })

  it('ignores malformed JSON without throwing', () => {
    const onMessage = vi.fn()
    connectMihomo({ wsURL: 'ws://h:9090', secret: '', onMessage })
    expect(() =>
      MockWebSocket.instances[0]!.onmessage!({ data: 'not json' }),
    ).not.toThrow()
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('reconnects after an unexpected close', async () => {
    vi.useFakeTimers()
    connectMihomo({ wsURL: 'ws://h:9090', secret: '', onMessage: () => {} })
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]!.onclose!({})
    await vi.advanceTimersByTimeAsync(4000)

    expect(MockWebSocket.instances).toHaveLength(2)
    vi.useRealTimers()
  })

  it('does not reconnect after close() is called', async () => {
    vi.useFakeTimers()
    const client = connectMihomo({
      wsURL: 'ws://h:9090',
      secret: '',
      onMessage: () => {},
    })
    const first = MockWebSocket.instances[0]!

    client.close()
    first.onclose?.({})
    await vi.advanceTimersByTimeAsync(4000)

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(first.close).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
