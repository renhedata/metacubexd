# Background Traffic Collector — Design

- **Date:** 2026-06-09
- **Status:** Approved (pending spec review)
- **Topic:** Persist per-connection traffic statistics that survive a full browser quit.

## Problem

Users want traffic usage to keep accumulating **even when the browser is fully
closed** ("浏览器完全退出后仍统计"), toggleable from Settings.

metacubexd computes traffic usage entirely **in the browser** by diffing
mihomo's `/connections` WebSocket (`stores/connections.ts` →
`updateDataUsage` → IndexedDB via `utils/db.ts`). When the browser process
exits, no JavaScript runs — not the page, not a service worker, not the PWA.
Therefore **no settings toggle inside the web app can collect traffic after the
browser is quit.** This is a browser/OS reality, not a metacubexd limitation
(the existing `dataUsageInfo` i18n string already concedes it).

The only way to count traffic while the browser is fully closed is to have a
process **other than the browser** hold the mihomo connection open: a daemon.

## Goal

Ship a small **independent collector daemon** in this repo that:

1. Holds mihomo's `/connections` WebSocket open 24/7 (independent of any browser).
2. Computes per-connection upload/download deltas using the **same logic** as the
   in-browser tracker.
3. Persists aggregated logs to a local SQLite file.
4. Exposes a tiny authenticated HTTP read API.

The existing **Data Usage page** reads from the collector instead of IndexedDB
when the user enables it in Settings.

## Non-goals

- Modifying mihomo (the Go core) — out of scope; different project.
- A service-worker approach — does **not** survive full browser quit, so it does
  not meet the requirement.
- Merging the collector dataset with the in-browser IndexedDB dataset — they
  remain separate; the page reads from whichever source is selected.
- Auto-syncing mihomo endpoint/secret from the frontend to the daemon — the
  daemon is configured independently via env.
- Docker packaging — deferred to an optional follow-up (see "Out of scope").

## Architecture

```
mihomo (always running)
   │  /connections WS (token)
   ▼
collector daemon (Node, 24/7) ──persist──▶ SQLite file (DB_PATH)
   │  GET /api/logs?start&end   (Bearer token + CORS)
   ▼
metacubexd frontend — Data Usage page reads here when the collector is enabled
```

### Runtime / tooling (approved)

- **Language:** TypeScript, run directly via **`tsx`** (new devDependency). Script:
  `pnpm collector` → `tsx collector/index.ts`.
- **Storage:** Node 24 built-in **`node:sqlite`** — no native dependency.
- **HTTP/WS:** Node built-ins only — `node:http` for the server and the global
  `WebSocket` (Node 24, via undici) for the mihomo client. No extra runtime
  dependency; reconnect is handled by our own `mihomo.ts` wrapper. (`ws` is a
  fallback only if the global client proves insufficient.)

## Collector modules (`collector/`)

Small, focused files. The diff logic is a **pure, unit-testable core**.

| File | Responsibility |
|---|---|
| `config.ts` | Read env config; validate required values; fail fast. |
| `tracker.ts` | **Pure** per-connection diff: minute-bucketing, restart detection, buffer aggregation. Ported from `updateDataUsage`. |
| `store.ts` | `node:sqlite` wrapper: `insertLogs`, `query(start,end)`, `cleanup(before)`, `clearAll`. Same `DataUsageLog` schema as `utils/db.ts`. |
| `mihomo.ts` | WebSocket client to `/connections` with auto-reconnect (mirrors the 3s reconnect in `useWebSocket.ts`). |
| `server.ts` | `node:http` server: `GET /api/logs`, `GET /api/health`, `DELETE /api/logs`. Bearer-token auth + CORS. |
| `index.ts` | Wiring: config → store → tracker ← mihomo, and start server. |

### Data model

Mirrors `DataUsageLog` from `utils/db.ts`:

```ts
interface DataUsageLog {
  id?: number
  timestamp: number   // minute bucket: Math.floor(now / 60000) * 60000
  sourceIP: string
  host: string
  outbound: string
  process: string
  inboundUser: string
  upload: number
  download: number
}
```

SQLite schema: table `data_usage_logs` with the columns above (`id` autoincrement
primary key) and an index on `timestamp`. Multiple flushes within the same minute
may insert multiple rows sharing a `timestamp`; the frontend aggregation sums
them (same as the IndexedDB model).

### Tracker behavior — two intentional differences from the in-browser tracker

Confirmed with the user:

1. **A mihomo core restart does NOT wipe persisted history.** The frontend clears
   data on restart (`clearDataUsage()` in `updateFromWsMsg`); the collector only
   **resets the per-connection baseline** (`connectionLastData`) and keeps
   persisted rows. Otherwise a core restart would erase the entire point of a
   persistent collector.
2. **First observation of a connection emits no delta (baseline-only).** The
   frontend counts the full cumulative on first sight (`uploadDelta =
   currentUpload`). The collector records the first sample as a baseline and only
   emits deltas from the *second* sample onward, so restarting the collector
   doesn't over-count in-flight connections' cumulative totals.

All other tracker logic (minute bucketing, composite buffer key, `Math.max(0,
delta)` clamping, 30s flush cadence) mirrors `stores/connections.ts`.

### HTTP API contract

All endpoints require `Authorization: Bearer <COLLECTOR_TOKEN>` (when a token is
configured) and emit CORS headers for `ALLOWED_ORIGIN` (default `*`).

- `GET /api/logs?start=<ms>&end=<ms>` → `200` `DataUsageLog[]` within the
  inclusive time range, ordered by `timestamp`.
- `GET /api/health` → `200 { ok: true, since: <ms>, count: <n> }`.
- `DELETE /api/logs` → `200 { ok: true }`; clears all stored logs (drives the
  Data Usage page's "clear" button in collector mode).
- Unauthorized → `401`; unknown route → `404`.

### Env configuration (`config.ts`)

| Var | Required | Default | Meaning |
|---|---|---|---|
| `MIHOMO_API_URL` | yes | — | mihomo external controller base URL (http/ws). |
| `MIHOMO_SECRET` | no | `''` | mihomo API secret (sent as `token` query param). |
| `PORT` | no | `9797` | Collector HTTP port. |
| `DB_PATH` | no | `./collector-data.sqlite` | SQLite file path. |
| `RETENTION_MS` | no | `0` (forever) | Delete rows older than this on each flush. |
| `COLLECTOR_TOKEN` | no | `''` | Bearer token required by the HTTP API. |
| `ALLOWED_ORIGIN` | no | `*` | CORS `Access-Control-Allow-Origin`. |

## Frontend integration (minimal)

All reads already funnel through a single call: `db.query(start,end)` inside
`composables/useDataUsage.ts` (7 call sites). Integration adds a thin source
selector and changes only that call.

- **New `composables/useDataUsageSource.ts`** — returns `{ query, clearAll }`
  backed by either the IndexedDB `db` or a `CollectorClient`, selected by
  `configStore.enableBackgroundCollector`.
  - `CollectorClient.query(start,end)` → `fetch(`${collectorURL}/api/logs?...`)`
    with the Bearer token; returns `DataUsageLog[]`. Validates/normalizes the
    response (defensive: untrusted external data).
  - `CollectorClient.clearAll()` → `fetch(DELETE /api/logs)`.
- **`composables/useDataUsage.ts`** — its `db.query(...)` calls become
  `source.query(...)`. No other logic changes; the aggregation functions are
  untouched.
- **`pages/traffic.vue`** — the "clear" button routes to the active source's
  `clearAll`; the local **retention** control is disabled in collector mode (the
  collector manages retention server-side via `RETENTION_MS`), with a hint.

Local in-browser recording (`enableDataUsageTracking`) is untouched and
independent. Collector mode only changes **where the page reads from**.

### Settings (the "在设置里面打开" part)

- **`stores/config.ts`** — add to the xd-config group, included in `resetXdConfig`:
  - `enableBackgroundCollector` — `useLocalStorage('enableBackgroundCollector', false)`
  - `collectorURL` — `useLocalStorage('collectorURL', '')`
  - `collectorToken` — `useLocalStorage('collectorToken', '')`
- **`pages/config.vue`** — in the xdConfig section, next to
  `enableDataUsageTracking`: a toggle for `enableBackgroundCollector`, plus a URL
  input and a token input (shown when enabled). Optional inline reachability hint
  via `GET /api/health`.
- **i18n** — add keys to `en.json`, `zh.json`, `ru.json`:
  `enableBackgroundCollector`, `enableBackgroundCollectorDesc` (honest: requires
  running the separate daemon; only then does data survive a full browser quit),
  `collectorURL`, `collectorToken`, `collectorUnreachable`.

## Deployment

The deployable unit is the Node process:

```bash
MIHOMO_API_URL=http://127.0.0.1:9090 MIHOMO_SECRET=xxx \
COLLECTOR_TOKEN=yyy PORT=9797 DB_PATH=./collector-data.sqlite \
pnpm collector
```

Run it under a process supervisor (systemd / pm2 / Docker) for 24/7 operation.
Then in metacubexd Settings, enable "background collector" and point it at
`http://<host>:9797` with the same token.

## Testing

- **Collector (vitest):**
  - `tracker.ts` — delta computation, `Math.max(0, …)` clamping, minute bucketing,
    core-restart baseline reset (history preserved), baseline-only first
    observation, buffer aggregation by composite key.
  - `store.ts` — `insertLogs` / `query` range filtering / `cleanup` / `clearAll`
    against a temp SQLite file.
- **Frontend (vitest, existing `__tests__` patterns):**
  - `useDataUsageSource` — source selection by config.
  - `CollectorClient.query` — mocked `fetch`, response normalization, error
    handling (unreachable / non-200).

## Out of scope / follow-ups

- **Docker image / compose** for the collector — optional follow-up.
- Server-side retention UI / per-source retention controls.
- Authentication beyond a shared bearer token.
- Reconciling/merging the collector dataset with the in-browser dataset.
