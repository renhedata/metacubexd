<script setup lang="ts">
const { connect, disconnect, reconnectLogs } = useBackendWebSocket()
const configStore = useConfigStore()
const endpointStore = useEndpointStore()
const { configureCollector } = useDataUsageSource()

// Connect WebSockets on mount
onMounted(() => {
  connect()
})

// Disconnect on unmount
onUnmounted(() => {
  disconnect()
})

// Reconnect logs WebSocket when log level changes
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
