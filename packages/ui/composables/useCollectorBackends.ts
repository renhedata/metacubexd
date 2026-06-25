// composables/useCollectorBackends.ts
import type { Ref } from 'vue'
import { ref } from 'vue'
import { z } from 'zod'

const backendSchema = z.object({
  url: z.string(),
  addedAt: z.number(),
  connected: z.boolean(),
  count: z.number(),
})
const backendsSchema = z.array(backendSchema)

export type CollectorBackend = z.infer<typeof backendSchema>

export interface CollectorBackends {
  backends: Ref<CollectorBackend[]>
  error: Ref<boolean>
  refresh: () => Promise<void>
  remove: (url: string) => Promise<void>
}

export function useCollectorBackends(): CollectorBackends {
  const configStore = useConfigStore()
  const backends = ref<CollectorBackend[]>([])
  const error = ref(false)

  const base = (): string => configStore.collectorURL.replace(/\/$/, '')

  const authHeaders = (): Record<string, string> =>
    configStore.collectorToken
      ? { Authorization: `Bearer ${configStore.collectorToken}` }
      : {}

  const refresh = async (): Promise<void> => {
    if (!base()) return
    try {
      const res = await fetch(`${base()}/api/backends`, {
        headers: authHeaders(),
      })
      if (!res.ok) {
        error.value = true
        return
      }
      backends.value = backendsSchema.parse(await res.json())
      error.value = false
    } catch {
      error.value = true
    }
  }

  const remove = async (url: string): Promise<void> => {
    try {
      const res = await fetch(
        `${base()}/api/backends?url=${encodeURIComponent(url)}`,
        { method: 'DELETE', headers: authHeaders() },
      )
      if (!res.ok) {
        throw new Error(
          `Collector backend removal failed with status ${res.status}`,
        )
      }
    } catch (e) {
      error.value = true
      throw e
    }
    await refresh()
  }

  return { backends, error, refresh, remove }
}
