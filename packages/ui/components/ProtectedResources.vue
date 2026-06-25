<script setup lang="ts">
const { connect, disconnect, reconnectLogs } = useBackendWebSocket()
const configStore = useConfigStore()
const { hasFeature, ready } = useControlInfo()
const kernelStore = useKernelStore()
const endpointStore = useEndpointStore()
const { configureCollector } = useDataUsageSource()

// Whether we should currently hold the backend WebSockets open.
// - Web dashboard (no kernel-control feature): always, as before.
// - Desktop: only while the managed kernel is running, since its Clash API port
//   is closed otherwise. Gate on `ready` so we don't connect before the
//   /api/control/info probe tells us which mode we're in.
const shouldConnect = computed(() => {
  if (!ready.value) return false
  if (!hasFeature('kernel-control')) return true
  return kernelStore.state?.status === 'running'
})

// Once the probe resolves in desktop kernel-control mode, seed the kernel status
// so `shouldConnect` reflects reality (the watcher then drives connect/disconnect
// on every subsequent start/stop).
watch(
  () => ready.value && hasFeature('kernel-control'),
  (isDesktopKernel) => {
    if (isDesktopKernel) {
      kernelStore
        .fetchStatus()
        .catch((err) =>
          console.error(
            '[protected-resources] initial kernel status failed',
            err,
          ),
        )
    }
  },
  { immediate: true },
)

watch(
  shouldConnect,
  (ok) => {
    if (ok) connect()
    else disconnect()
  },
  { immediate: true },
)

// Disconnect on unmount
onUnmounted(() => {
  disconnect()
})

// Reconnect logs WebSocket when log level changes (a no-op while the kernel is
// down — createLogsWebSocket() applies the same kernel gate).
watch(
  () => configStore.logLevel,
  () => {
    reconnectLogs()
  },
)

// Auto-sync: when the background collector is enabled, push the dashboard's
// current mihomo endpoint to it so the user never enters the mihomo URL/secret
// manually. Re-pushes when the collector address or the selected endpoint
// changes. Best-effort — failures (collector down, blank URL) are ignored.
watch(
  () => [
    configStore.enableBackgroundCollector,
    configStore.collectorURL,
    configStore.collectorToken,
    endpointStore.selectedEndpoint,
  ],
  ([enabled]) => {
    if (enabled) configureCollector().catch(() => {})
  },
  { immediate: true },
)
</script>

<template>
  <!-- This component manages WebSocket connections -->
  <div class="hidden" />
</template>
