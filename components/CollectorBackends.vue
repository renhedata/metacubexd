<script setup lang="ts">
const { t } = useI18n()
const { backends, error, refresh, remove } = useCollectorBackends()

onMounted(() => {
  refresh().catch(() => {})
})

const handleRemove = async (url: string): Promise<void> => {
  if (!confirm(t('collectorBackendRemoveConfirm'))) return
  try {
    await remove(url)
  } catch {
    // surfaced via the error flag on the next refresh
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <span class="text-xs opacity-70">{{ t('collectorBackends') }}</span>
    <span v-if="error" class="text-xs text-error">
      {{ t('collectorHealthFail') }}
    </span>
    <span v-else-if="backends.length === 0" class="text-xs opacity-40">
      {{ t('collectorBackendsEmpty') }}
    </span>
    <div
      v-for="b in backends"
      :key="b.url"
      class="flex items-center justify-between gap-2 rounded-lg bg-base-content/5 px-2 py-1.5"
    >
      <div class="flex min-w-0 flex-col">
        <span class="truncate text-xs">{{ b.url }}</span>
        <span class="text-xs opacity-50">
          {{
            b.connected
              ? t('collectorBackendConnected')
              : t('collectorBackendDisconnected')
          }}
          · {{ t('collectorBackendLogs', { count: b.count }) }}
        </span>
      </div>
      <button
        class="btn text-error btn-ghost btn-xs"
        @click="handleRemove(b.url)"
      >
        {{ t('collectorBackendRemove') }}
      </button>
    </div>
  </div>
</template>
