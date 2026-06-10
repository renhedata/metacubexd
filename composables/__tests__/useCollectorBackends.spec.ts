// composables/__tests__/useCollectorBackends.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollectorBackends } from '../useCollectorBackends'

const configStore = {
  collectorURL: 'http://collector:9797',
  collectorToken: 'tok',
}

vi.stubGlobal('useConfigStore', () => configStore)

const row = {
  url: 'http://127.0.0.1:9090',
  addedAt: 1000,
  connected: true,
  count: 5,
}

beforeEach(() => {
  vi.clearAllMocks()
  configStore.collectorURL = 'http://collector:9797'
  configStore.collectorToken = 'tok'
})

describe('composables/useCollectorBackends', () => {
  it('refresh fetches and stores the backend list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [row] })
    vi.stubGlobal('fetch', fetchMock)

    const { backends, refresh } = useCollectorBackends()
    await refresh()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://collector:9797/api/backends',
      { headers: { Authorization: 'Bearer tok' } },
    )
    expect(backends.value).toEqual([row])
  })

  it('refresh flags an error on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    )

    const { error, refresh } = useCollectorBackends()
    await refresh()

    expect(error.value).toBe(true)
  })

  it('refresh is a no-op when no collector URL is set', async () => {
    configStore.collectorURL = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { refresh } = useCollectorBackends()
    await refresh()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('remove DELETEs the backend then refreshes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)

    const { remove } = useCollectorBackends()
    await remove('http://127.0.0.1:9090')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `http://collector:9797/api/backends?url=${encodeURIComponent('http://127.0.0.1:9090')}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://collector:9797/api/backends',
      { headers: { Authorization: 'Bearer tok' } },
    )
  })
})
