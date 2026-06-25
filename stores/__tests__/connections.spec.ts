import type { WsMsg } from '~/types'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { useConnectionsStore } from '../connections'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
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
    key: (i: number) => Object.keys(store)[i] ?? null,
  }
})()
vi.stubGlobal('localStorage', localStorageMock)

const mockGlobalStore = { clearChartHistory: vi.fn() }
const mockEndpointStore = reactive({ selectedEndpoint: 'endpoint-a' })

vi.stubGlobal('useGlobalStore', () => mockGlobalStore)
vi.stubGlobal('useEndpointStore', () => mockEndpointStore)

function makeConn(id: string, upload: number, download: number) {
  return {
    id,
    upload,
    download,
    chains: ['DIRECT'],
    metadata: {
      sourceIP: '10.0.0.1',
      host: 'example.com',
      destinationIP: '93.184.216.34',
      process: 'curl',
      inboundUser: 'user',
      type: 'http',
    },
  }
}

function makeMsg(
  uploadTotal: number,
  downloadTotal: number,
  connections: ReturnType<typeof makeConn>[],
): WsMsg {
  return { uploadTotal, downloadTotal, connections } as unknown as WsMsg
}

describe('stores/connections restart detection vs endpoint switch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorageMock.clear()
    mockEndpointStore.selectedEndpoint = 'endpoint-a'
  })

  it('does not wipe the chart when switching endpoints', async () => {
    const store = useConnectionsStore()
    store.updateFromWsMsg(makeMsg(1000, 2000, [makeConn('c1', 500, 1000)]))

    mockEndpointStore.selectedEndpoint = 'endpoint-b'
    await nextTick()

    store.updateFromWsMsg(makeMsg(10, 20, [makeConn('c2', 5, 10)]))

    expect(mockGlobalStore.clearChartHistory).not.toHaveBeenCalled()
  })

  it('clears the chart on a real kernel restart on the same endpoint', () => {
    const store = useConnectionsStore()
    store.updateFromWsMsg(makeMsg(1000, 2000, [makeConn('c1', 500, 1000)]))
    store.updateFromWsMsg(makeMsg(10, 20, [makeConn('c1', 5, 10)]))

    expect(mockGlobalStore.clearChartHistory).toHaveBeenCalled()
  })
})
