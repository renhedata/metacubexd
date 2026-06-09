// stores/__tests__/configCollector.spec.ts
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useConfigStore } from '../config'

describe('stores/config — background collector settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('defaults collector settings to off/empty', () => {
    const store = useConfigStore()
    expect(store.enableBackgroundCollector).toBe(false)
    expect(store.collectorURL).toBe('')
    expect(store.collectorToken).toBe('')
  })

  it('resetXdConfig turns the collector back off', () => {
    const store = useConfigStore()
    store.enableBackgroundCollector = true
    store.collectorURL = 'http://localhost:9797'
    store.resetXdConfig()
    expect(store.enableBackgroundCollector).toBe(false)
  })
})
