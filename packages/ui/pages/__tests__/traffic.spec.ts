import type { Mock } from 'vitest'
import type { EffectScope, Ref } from 'vue'
import type {
  AggregatedData,
  TrafficTrendPoint,
} from '~/composables/useDataUsage'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import dayjs from 'dayjs'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

interface TrafficState {
  activeView: Ref<string>
  selectedTimeRange: Ref<number>
  dataUsageEntries: Ref<AggregatedData[]>
  trendData: Ref<TrafficTrendPoint[]>
  hasDimensionData: Ref<boolean>
  hasTrendData: Ref<boolean>
  dimensionError: Ref<string>
  trendError: Ref<string>
  subStatsMap: Ref<Record<string, AggregatedData[]>>
  proxyStatsMap: Ref<Record<string, AggregatedData[]>>
  handleRowClick: (label: string) => Promise<void>
  handleSubRowClick: (parent: string, label: string) => Promise<void>
}

// Compile only setup: these tests exercise the page's real watchers/request state,
// without mounting charts or requiring a Nuxt server/Vite Vue plugin.
const { descriptor } = parse(
  readFileSync(resolve(process.cwd(), 'pages/traffic.vue'), 'utf8'),
)
const setupCode = transpileModule(
  compileScript(descriptor, { id: 'traffic-test' }).content,
  {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  },
).outputText

const entry = (label: string): AggregatedData => ({
  label,
  kind: 'sourceIP',
  upload: 1,
  download: 2,
  total: 3,
  count: 1,
})
const trend: TrafficTrendPoint[] = [{ timestamp: 10, upload: 1, download: 2 }]
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await vue.nextTick()
}

interface DeferredLoad<T> {
  requests: Array<PromiseWithResolvers<T> & { signal: AbortSignal }>
  load: Mock<(...args: unknown[]) => Promise<T>>
}

function deferredLoad<T>(): DeferredLoad<T> {
  const requests: Array<PromiseWithResolvers<T> & { signal: AbortSignal }> = []
  const load = vi.fn((...args: unknown[]) => {
    const request = {
      ...Promise.withResolvers<T>(),
      signal: args.at(-1) as AbortSignal,
    }
    requests.push(request)
    return request.promise
  })
  return { requests, load }
}

let dispose = () => {}
let scope: EffectScope
let state: TrafficState
let config: { collectorURL: string; collectorToken: string }
let endpoint: { currentEndpoint: { url: string } }
let focus: Ref<boolean>
let dimensions: DeferredLoad<AggregatedData[]>
let trends: DeferredLoad<TrafficTrendPoint[]>
let sub: DeferredLoad<AggregatedData[]>
let proxy: DeferredLoad<AggregatedData[]>

beforeEach(() => {
  dimensions = deferredLoad<AggregatedData[]>()
  trends = deferredLoad<TrafficTrendPoint[]>()
  sub = deferredLoad<AggregatedData[]>()
  proxy = deferredLoad<AggregatedData[]>()
  config = vue.reactive({
    collectorURL: 'http://collector',
    collectorToken: 'token',
  })
  endpoint = vue.reactive({ currentEndpoint: { url: 'http://backend-a' } })
  focus = vue.ref(true)
  const modules: Record<string, unknown> = {
    vue,
    dayjs,
    '@tabler/icons-vue': {},
    '~/utils': { formatBytes: String, formatDuration: () => '' },
    '~/composables/useDataUsageSource': {
      useDataUsageSource: () => ({
        ready: () => true,
        clearCollectorData: vi.fn(),
      }),
    },
    '~/composables/useDataUsage': {
      useDataUsage: () => ({
        getAggregatedData: dimensions.load,
        getTrafficTrend: trends.load,
        getSubStatsByHost: sub.load,
        getDevicesByHost: sub.load,
        getProxyStatsByHost: proxy.load,
        getDevicesByProxyAndHost: proxy.load,
      }),
    },
  }
  const exports: {
    default?: { setup: (props: object, context: object) => TrafficState }
  } = {}
  runInNewContext(setupCode, {
    exports,
    require: (name: string) => {
      if (!(name in modules))
        throw new Error(`Unexpected setup import: ${name}`)
      return modules[name]
    },
    ref: vue.ref,
    computed: vue.computed,
    watch: vue.watch,
    Error,
    AbortController,
    useI18n: () => ({ t: (key: string) => key }),
    useConfigStore: () => config,
    useEndpointStore: () => endpoint,
    useHead: vi.fn(),
    useReverseDns: () => ({ label: (ip: string) => ip }),
    useLocalStorage: (_key: string, value: unknown) => vue.ref(value),
    useWindowFocus: () => focus,
    useThrottleFn: (fn: unknown) => fn,
    onBeforeUnmount: (fn: () => void) => {
      dispose = fn
    },
  })
  scope = vue.effectScope()
  state = scope.run(() => exports.default!.setup({}, { expose: vi.fn() }))!
})

afterEach(() => {
  dispose()
  scope.stop()
})

describe('traffic loading', () => {
  it('displays dimensions before a slow/failed trend without substituting zeros', async () => {
    dimensions.requests[0]!.resolve([entry('client')])
    await flush()
    expect(state.hasDimensionData.value).toBe(true)
    expect(state.hasTrendData.value).toBe(false)
    expect(state.dataUsageEntries.value[0]?.label).toBe('client')
    trends.requests[0]!.reject(new Error('trend failed'))
    await flush()
    expect(state.trendError.value).toBe('trend failed')
    expect(state.trendData.value).toEqual([])
    expect(state.hasTrendData.value).toBe(false)
    expect(state.hasDimensionData.value).toBe(true)
  })

  it('displays trend independently and ignores obsolete selections even if abort is ignored', async () => {
    trends.requests[0]!.resolve(trend)
    await flush()
    expect(state.hasTrendData.value).toBe(true)
    expect(state.hasDimensionData.value).toBe(false)
    state.activeView.value = 'host'
    expect(dimensions.requests[0]!.signal.aborted).toBe(true)
    dimensions.requests[0]!.resolve([entry('obsolete')])
    await flush()
    expect(state.dataUsageEntries.value).toEqual([])
    dimensions.requests[1]!.resolve([entry('latest')])
    trends.requests[1]!.resolve(trend)
    await flush()
    expect(state.dataUsageEntries.value[0]?.label).toBe('latest')
  })

  it('does not duplicate an active load on focus and watches actual collector/backend settings', async () => {
    focus.value = false
    await flush()
    focus.value = true
    await flush()
    expect(dimensions.requests).toHaveLength(1)
    config.collectorToken = 'new-token'
    config.collectorURL = 'http://other-collector'
    endpoint.currentEndpoint.url = 'http://backend-b'
    expect(dimensions.requests).toHaveLength(4)
    expect(
      dimensions.requests
        .slice(0, 3)
        .every((request) => request.signal.aborted),
    ).toBe(true)
    dimensions.requests[0]!.reject(new DOMException('cancelled', 'AbortError'))
    await flush()
    expect(state.dimensionError.value).toBe('')
  })

  it('cancels superseded drilldowns and all outstanding work on unmount', async () => {
    dimensions.requests[0]!.resolve([entry('first'), entry('second')])
    await flush()
    void state.handleRowClick('second')
    expect(sub.requests[0]!.signal.aborted).toBe(true)
    sub.requests[0]!.resolve([entry('obsolete-host')])
    sub.requests[1]!.resolve([entry('latest-host')])
    await flush()
    expect(state.subStatsMap.value.first).toBeUndefined()
    expect(state.subStatsMap.value.second?.[0]?.label).toBe('latest-host')
    void state.handleSubRowClick('second', 'host-a')
    void state.handleSubRowClick('second', 'host-b')
    expect(proxy.requests[0]!.signal.aborted).toBe(true)
    dispose()
    expect(proxy.requests[1]!.signal.aborted).toBe(true)
    expect(trends.requests[0]!.signal.aborted).toBe(true)
    proxy.requests[1]!.resolve([entry('obsolete-proxy')])
    trends.requests[0]!.resolve(trend)
    await flush()
    expect(state.proxyStatsMap.value).toEqual({})
    expect(state.hasTrendData.value).toBe(false)
  })
})
