<script setup lang="ts">
import type {
  AggregatedData,
  TrafficTrendPoint,
} from '~/composables/useDataUsage'
import type { DataUsageType } from '~/types'
import {
  IconArrowsExchange,
  IconClock,
  IconCpu,
  IconDevices,
  IconDownload,
  IconSum,
  IconTrash,
  IconUpload,
  IconUser,
  IconWorld,
} from '@tabler/icons-vue'
import dayjs from 'dayjs'
import { useDataUsage } from '~/composables/useDataUsage'
import { useDataUsageSource } from '~/composables/useDataUsageSource'
import { formatBytes, formatDuration } from '~/utils'

const { t } = useI18n()
const {
  getAggregatedData,
  getSubStatsByHost,
  getProxyStatsByHost,
  getTrafficTrend,
  getDevicesByHost,
  getDevicesByProxyAndHost,
} = useDataUsage()
const dataSource = useDataUsageSource()
const { clearCollectorData } = dataSource
const isCollectorReady = computed(() => dataSource.ready())
const configStore = useConfigStore()
const endpointStore = useEndpointStore()

const reverseDns = useReverseDns()
const formatClientLabel = (ip: string) => reverseDns.label(ip)
const clientLabelTitle = (ip: string) => {
  const name = reverseDns.label(ip)
  return name !== ip ? ip : ''
}

useHead({ title: computed(() => t('dataUsage')) })
type SortField = 'label' | 'upload' | 'download' | 'total' | 'count'
type SortOrder = 'asc' | 'desc'

const sortField = ref<SortField>('total')
const sortOrder = ref<SortOrder>('desc')
const activeView = useLocalStorage<DataUsageType>(
  'traffic_active_view',
  'sourceIP',
)

const timeRangeOptions = computed(() => [
  { label: t('lastHour'), value: 3600000 },
  { label: t('lastDay'), value: 86400000 },
  { label: t('lastWeek'), value: 604800000 },
  { label: t('lastMonth'), value: 2592000000 },
  { label: t('customRange'), value: -1 },
])
const selectedTimeRange = useLocalStorage('traffic_time_range', 3600000)

// Custom Time Range State (Persisted)
const customStart = useLocalStorage(
  'traffic_custom_start',
  dayjs().subtract(1, 'day').format('YYYY-MM-DDTHH:mm'),
)
const customEnd = useLocalStorage(
  'traffic_custom_end',
  dayjs().format('YYYY-MM-DDTHH:mm'),
)

const dataUsageEntries = ref<AggregatedData[]>([])
const trendData = ref<TrafficTrendPoint[]>([])
const hasDimensionData = ref(false)
const hasTrendData = ref(false)
const dimensionError = ref('')
const trendError = ref('')
const drilldownError = ref('')
let mainRequest: AbortController | undefined
let subRequest: AbortController | undefined
let proxyRequest: AbortController | undefined
let disposed = false
const selectedRow = ref<string | null>(null)
const selectedSubRow = ref<string | null>(null)
const subStatsMap = ref<Record<string, AggregatedData[]>>({})
const proxyStatsMap = ref<Record<string, AggregatedData[]>>({})

// Helper: Get active time range
const getTimeRange = () => {
  if (selectedTimeRange.value === -1) {
    return {
      startTime: dayjs(customStart.value).valueOf(),
      endTime: dayjs(customEnd.value).valueOf(),
    }
  }
  const endTime = Date.now()
  return {
    endTime,
    startTime: endTime - selectedTimeRange.value,
  }
}

const loadedRange = ref(getTimeRange())
const trendRange = ref(loadedRange.value)
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const cancelDrilldowns = () => {
  subRequest?.abort()
  proxyRequest?.abort()
}

const fetchData = async () => {
  if (disposed) return
  mainRequest?.abort()
  cancelDrilldowns()
  selectedSubRow.value = null
  if (!isCollectorReady.value) return
  const request = new AbortController()
  mainRequest = request
  const { signal } = request
  const view = activeView.value
  const { startTime, endTime } = getTimeRange()
  loadedRange.value = { startTime, endTime }
  dimensionError.value = ''
  trendError.value = ''
  drilldownError.value = ''

  const rangeMs = endTime - startTime
  const bucketSizeMs =
    rangeMs <= 3600000
      ? 60000
      : rangeMs <= 86400000
        ? 300000
        : rangeMs <= 604800000
          ? 3600000
          : 86400000

  // Apply each result immediately; the other query can still be running.
  await Promise.allSettled([
    getAggregatedData(view, startTime, endTime, signal)
      .then((aggregated) => {
        if (signal.aborted) return
        dataUsageEntries.value = aggregated
        hasDimensionData.value = true
        const sorted = sortedDataUsageEntries.value
        if (
          !selectedRow.value ||
          !aggregated.some((row) => row.label === selectedRow.value)
        ) {
          selectedRow.value = sorted[0]?.label ?? null
        }
        if (selectedRow.value) void loadSubStats(selectedRow.value)
      })
      .catch((error: unknown) => {
        if (!signal.aborted) dimensionError.value = errorMessage(error)
      }),
    getTrafficTrend(startTime, endTime, bucketSizeMs, signal)
      .then((trend) => {
        if (signal.aborted) return
        trendData.value = trend
        trendRange.value = { startTime, endTime }
        hasTrendData.value = true
      })
      .catch((error: unknown) => {
        if (!signal.aborted) trendError.value = errorMessage(error)
      }),
  ])
  if (mainRequest === request) mainRequest = undefined
}

const viewOptions = computed(() => [
  { label: t('devices'), value: 'sourceIP', icon: IconDevices },
  { label: t('user'), value: 'inboundUser', icon: IconUser },
  { label: t('host'), value: 'host', icon: IconWorld },
  { label: t('proxies'), value: 'outbound', icon: IconArrowsExchange },
  { label: t('process'), value: 'process', icon: IconCpu },
])
const currentViewOption = computed(() =>
  viewOptions.value.find((o) => o.value === activeView.value),
)

const sortedDataUsageEntries = computed(() => {
  const entries = [...dataUsageEntries.value]
  const field = sortField.value
  const order = sortOrder.value

  return entries.sort((a, b) => {
    let comparison = 0
    if (field === 'label') comparison = a.label.localeCompare(b.label)
    else comparison = (a[field] as number) - (b[field] as number)
    return order === 'asc' ? comparison : -comparison
  })
})

const totalStats = computed(() => {
  const entries = dataUsageEntries.value
  const totalUpload = entries.reduce((sum, entry) => sum + entry.upload, 0)
  const totalDownload = entries.reduce((sum, entry) => sum + entry.download, 0)

  const { startTime, endTime } = getTimeRange()
  const durationText = formatDuration(startTime, endTime)

  return {
    count: entries.length,
    upload: totalUpload,
    download: totalDownload,
    total: totalUpload + totalDownload,
    durationText,
  }
})

async function handleClearAll() {
  if (!confirm(t('confirmClearAll'))) return
  await clearCollectorData()
  await fetchData()
}

const handleRowClick = async (label: string) => {
  if (disposed || !isCollectorReady.value) return
  selectedRow.value = label
  selectedSubRow.value = null
  await loadSubStats(label)
}

const loadSubStats = async (label: string) => {
  cancelDrilldowns()
  if (disposed || !isCollectorReady.value) return
  const request = new AbortController()
  subRequest = request
  const { signal } = request
  const view = activeView.value
  const { startTime, endTime } = loadedRange.value
  drilldownError.value = ''
  try {
    const rows =
      view === 'host'
        ? await getDevicesByHost(label, startTime, endTime, signal)
        : await getSubStatsByHost(view, label, startTime, endTime, signal)
    if (!signal.aborted) subStatsMap.value[label] = rows
  } catch (error) {
    if (!signal.aborted) drilldownError.value = errorMessage(error)
  }
}

const handleSubRowClick = async (parentLabel: string, subLabel: string) => {
  if (disposed || !isCollectorReady.value) return
  proxyRequest?.abort()
  const compositeKey = `${parentLabel}:${subLabel}`
  if (selectedSubRow.value === compositeKey) {
    selectedSubRow.value = null
    return
  }
  selectedSubRow.value = compositeKey
  const request = new AbortController()
  proxyRequest = request
  const { signal } = request
  const view = activeView.value
  const { startTime, endTime } = loadedRange.value
  drilldownError.value = ''
  try {
    const rows =
      view === 'host'
        ? await getProxyStatsByHost(
            'sourceIP',
            subLabel,
            parentLabel,
            startTime,
            endTime,
            signal,
          )
        : view === 'outbound'
          ? await getDevicesByProxyAndHost(
              parentLabel,
              subLabel,
              startTime,
              endTime,
              signal,
            )
          : await getProxyStatsByHost(
              view,
              parentLabel,
              subLabel,
              startTime,
              endTime,
              signal,
            )
    if (!signal.aborted) proxyStatsMap.value[compositeKey] = rows
  } catch (error) {
    if (!signal.aborted) drilldownError.value = errorMessage(error)
  }
}

watch(
  () => [
    activeView.value,
    selectedTimeRange.value,
    selectedTimeRange.value === -1 ? customStart.value : '',
    selectedTimeRange.value === -1 ? customEnd.value : '',
    isCollectorReady.value,
    configStore.collectorURL,
    configStore.collectorToken,
    endpointStore.currentEndpoint?.url,
  ],
  () => {
    selectedRow.value = null
    selectedSubRow.value = null
    subStatsMap.value = {}
    proxyStatsMap.value = {}
    dataUsageEntries.value = []
    trendData.value = []
    hasDimensionData.value = false
    hasTrendData.value = false
    void fetchData()
  },
  { immediate: true, flush: 'sync' },
)

watch(
  useWindowFocus(),
  useThrottleFn(
    (focused: boolean) => {
      if (focused && selectedTimeRange.value !== -1 && !mainRequest)
        void fetchData()
    },
    30000,
    true,
    true,
  ),
)

onBeforeUnmount(() => {
  disposed = true
  mainRequest?.abort()
  cancelDrilldowns()
})

const currentViewLabel = computed(
  () =>
    viewOptions.value.find((o) => o.value === activeView.value)?.label ||
    t('name'),
)
</script>

<template>
  <div class="flex h-full flex-col gap-4 overflow-hidden">
    <template v-if="isCollectorReady">
      <!-- Header Row -->
      <div
        class="animate-fade-slide-in flex shrink-0 flex-wrap items-center justify-between gap-3 px-1"
      >
        <div
          class="flex shrink-0 gap-1 rounded-lg border border-[color-mix(in_oklab,var(--color-base-content)_12%,transparent)] bg-base-200/60 p-1"
        >
          <button
            v-for="opt in viewOptions"
            :key="opt.value"
            class="flex cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-3 py-1.5 text-[0.8125rem] font-medium text-base-content/60 transition-all duration-200 hover:bg-base-content/5 hover:text-base-content"
            :class="{
              'bg-primary! text-primary-content! shadow-[0_2px_8px_color-mix(in_oklab,var(--color-primary)_30%,transparent)]':
                activeView === opt.value,
            }"
            @click="activeView = opt.value as DataUsageType"
          >
            <component :is="opt.icon" :size="16" />
            <span class="hidden sm:inline">{{ opt.label }}</span>
          </button>
        </div>

        <!-- Time & Action Area -->
        <div class="flex items-center gap-2">
          <div
            v-if="selectedTimeRange === -1"
            class="animate-in fade-in zoom-in-95 flex items-center gap-1"
          >
            <input
              v-model="customStart"
              type="datetime-local"
              class="rounded-lg border border-[color-mix(in_oklab,var(--color-base-content)_12%,transparent)] bg-base-200/60 px-2 py-1.5 text-[0.75rem] text-base-content focus:border-primary focus:outline-none"
            />
            <span class="text-[10px] opacity-30">→</span>
            <input
              v-model="customEnd"
              type="datetime-local"
              class="rounded-lg border border-[color-mix(in_oklab,var(--color-base-content)_12%,transparent)] bg-base-200/60 px-2 py-1.5 text-[0.75rem] text-base-content focus:border-primary focus:outline-none"
            />
          </div>

          <div class="flex items-center gap-1">
            <span class="hidden text-[0.75rem] text-base-content/50 md:inline">
              {{ t('timeRange') }}
            </span>
            <div class="relative">
              <select
                v-model.number="selectedTimeRange"
                :title="t('timeRange')"
                class="cursor-pointer appearance-none rounded-lg border border-[color-mix(in_oklab,var(--color-base-content)_12%,transparent)] bg-base-200/60 py-1.5 pr-8 pl-3 text-[0.8125rem] text-base-content transition-all duration-200 hover:border-[color-mix(in_oklab,var(--color-base-content)_20%,transparent)] focus:border-primary focus:outline-none"
                style="
                  background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E&quot;);
                  background-repeat: no-repeat;
                  background-position: right 0.5rem center;
                  background-size: 1rem;
                "
              >
                <option
                  v-for="opt in timeRangeOptions"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}
                </option>
              </select>
            </div>
          </div>

          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-[color-mix(in_oklab,var(--color-base-content)_12%,transparent)] bg-base-200/60 text-base-content transition-all duration-200 hover:border-error/30 hover:bg-error/15 hover:text-error"
            :title="t('clearAll')"
            @click="handleClearAll"
          >
            <IconTrash :size="18" />
          </button>
        </div>
      </div>

      <!-- Main Workspace (Internal Scroll) -->
      <div class="min-h-0 flex-1 overflow-y-auto pr-1">
        <div class="flex flex-col gap-4">
          <!-- Summary Cards -->
          <div
            v-if="hasDimensionData"
            class="grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4"
          >
            <div
              class="animate-fade-slide-in flex h-16 items-center gap-3 rounded-2xl border border-[color-mix(in_oklab,var(--color-base-content)_10%,transparent)] bg-base-200/50 p-3 shadow-sm [animation-delay:50ms] xl:h-20"
            >
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary xl:h-10 xl:w-10 xl:rounded-xl"
              >
                <component
                  :is="currentViewOption?.icon || IconDevices"
                  :size="18"
                />
              </div>
              <div class="flex min-w-0 flex-col">
                <span
                  class="mb-1 truncate text-[7px] leading-none font-black tracking-widest uppercase opacity-40 xl:text-[9px]"
                  >{{ currentViewLabel }}</span
                >
                <span class="text-sm leading-tight font-black xl:text-lg">{{
                  totalStats.count
                }}</span>
              </div>
            </div>
            <div
              class="animate-fade-slide-in flex h-16 items-center gap-3 rounded-2xl border border-[color-mix(in_oklab,var(--color-base-content)_10%,transparent)] bg-base-200/50 p-3 shadow-sm [animation-delay:100ms] xl:h-20"
            >
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success xl:h-10 xl:w-10 xl:rounded-xl"
              >
                <IconUpload :size="18" />
              </div>
              <div class="flex min-w-0 flex-col">
                <span
                  class="mb-1 truncate text-[7px] leading-none font-black tracking-widest uppercase opacity-40 xl:text-[9px]"
                  >{{ t('upload') }}</span
                >
                <span class="text-sm leading-tight font-black xl:text-lg">{{
                  formatBytes(totalStats.upload)
                }}</span>
              </div>
            </div>
            <div
              class="animate-fade-slide-in flex h-16 items-center gap-3 rounded-2xl border border-[color-mix(in_oklab,var(--color-base-content)_10%,transparent)] bg-base-200/50 p-3 shadow-sm [animation-delay:150ms] xl:h-20"
            >
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info xl:h-10 xl:w-10 xl:rounded-xl"
              >
                <IconDownload :size="18" />
              </div>
              <div class="flex min-w-0 flex-col">
                <span
                  class="mb-1 truncate text-[7px] leading-none font-black tracking-widest uppercase opacity-40 xl:text-[9px]"
                  >{{ t('download') }}</span
                >
                <span class="text-sm leading-tight font-black xl:text-lg">{{
                  formatBytes(totalStats.download)
                }}</span>
              </div>
            </div>
            <div
              class="animate-fade-slide-in relative flex h-16 items-center gap-3 overflow-hidden rounded-2xl border border-[color-mix(in_oklab,var(--color-base-content)_10%,transparent)] bg-base-200/50 p-3 shadow-sm [animation-delay:200ms] xl:h-20"
            >
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary/10 text-secondary xl:h-10 xl:w-10 xl:rounded-xl"
              >
                <IconSum :size="18" />
              </div>
              <div class="flex min-w-0 flex-col">
                <span
                  class="mb-1 truncate text-[7px] leading-none font-black tracking-widest uppercase opacity-40 xl:text-[9px]"
                  >{{ t('total') }}</span
                >
                <span
                  class="text-sm leading-tight font-black text-secondary xl:text-lg"
                  >{{ formatBytes(totalStats.total) }}</span
                >
              </div>
              <div
                class="absolute top-1 right-2 flex origin-right scale-75 items-center gap-1 opacity-30 xl:top-2 xl:right-3 xl:scale-100"
              >
                <IconClock :size="12" />
                <span
                  class="text-[8px] font-black tracking-wider uppercase xl:text-[10px]"
                  >{{ totalStats.durationText }}</span
                >
              </div>
            </div>
          </div>

          <!-- Row 1: Rankings & Trend Chart -->
          <div
            class="grid h-auto shrink-0 grid-cols-1 gap-4 xl:h-[320px] xl:grid-cols-4"
          >
            <div
              class="animate-fade-slide-in col-span-1 min-h-[300px] w-full overflow-hidden rounded-xl border border-[color-mix(in_oklab,var(--color-base-content)_10%,transparent)] bg-base-200 p-4 shadow-sm transition-all duration-200 [animation-delay:250ms] hover:border-[color-mix(in_oklab,var(--color-base-content)_20%,transparent)] xl:h-full"
            >
              <p v-if="dimensionError" role="alert" class="text-error">
                {{ t('error') }}: {{ dimensionError }}
              </p>
              <span
                v-if="!hasDimensionData && !dimensionError"
                class="loading loading-spinner"
                :aria-label="t('dataUsage')"
              />
              <TrafficRankings
                v-if="hasDimensionData"
                :title="t('topProxies').slice(0, 2) + currentViewLabel"
                :icon="currentViewOption?.icon"
                :data="sortedDataUsageEntries"
                :selected-row="selectedRow"
                :label-formatter="formatClientLabel"
                :label-title="clientLabelTitle"
                @select="handleRowClick"
              />
            </div>

            <div
              class="animate-fade-slide-in col-span-1 min-h-[320px] min-w-0 overflow-hidden rounded-xl border border-[color-mix(in_oklab,var(--color-base-content)_10%,transparent)] bg-base-200 p-2 shadow-sm transition-all duration-200 [animation-delay:300ms] hover:border-[color-mix(in_oklab,var(--color-base-content)_20%,transparent)] xl:col-span-3 xl:h-full"
            >
              <p v-if="trendError" role="alert" class="text-error">
                {{ t('error') }}: {{ trendError }}
              </p>
              <span
                v-if="!hasTrendData && !trendError"
                class="loading loading-spinner"
                :aria-label="t('traffic')"
              />
              <TrafficTrendChart
                v-if="hasTrendData"
                :data="trendData"
                :start-time="trendRange.startTime"
                :end-time="trendRange.endTime"
                :title="t('traffic')"
              />
            </div>
          </div>

          <!-- Row 3: Full-width Detail Table -->
          <div class="animate-fade-slide-in [animation-delay:350ms]">
            <p v-if="drilldownError" role="alert" class="text-error">
              {{ t('error') }}: {{ drilldownError }}
            </p>
            <TrafficDetailsTable
              v-if="selectedRow"
              :selected-row="selectedRow"
              :active-view="activeView"
              :sub-stats="subStatsMap[selectedRow] || []"
              :proxy-stats-map="proxyStatsMap"
              :selected-sub-row="selectedSubRow"
              :label-formatter="formatClientLabel"
              :label-title="clientLabelTitle"
              @sub-row-click="handleSubRowClick"
            />
          </div>
        </div>
      </div>
    </template>
    <div
      v-else
      class="flex h-full flex-col items-center justify-center gap-4 text-center"
    >
      <p class="text-lg font-semibold">{{ t('collectorNotConfigured') }}</p>
      <p class="max-w-md text-sm opacity-60">
        {{ t('collectorNotConfiguredDesc') }}
      </p>
      <NuxtLink to="/config" class="btn btn-primary btn-sm">
        {{ t('goToSettings') }}
      </NuxtLink>
    </div>
  </div>
</template>

<style>
@keyframes fade-slide-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-fade-slide-in {
  animation: fade-slide-in 0.4s ease-out backwards;
}
</style>
