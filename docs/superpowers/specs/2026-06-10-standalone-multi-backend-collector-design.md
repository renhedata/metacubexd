# Standalone Multi-Backend Collector — Design

Date: 2026-06-10
Status: Approved
Supersedes the bundled (single-container, `/__collector` same-origin proxy)
deployment introduced in commit 0e33ab5. Extends
`2026-06-09-background-traffic-collector-design.md`.

## Goal

Un-bundle the background traffic collector from the dashboard and run it as a
standalone service behind a reverse proxy (Coolify). The dashboard reaches it
via a public domain + API key. The collector collects from **multiple mihomo
backends simultaneously**, storing each backend's data separately.

## Decisions (confirmed with user)

| Question                                               | Decision                                                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-backend behavior                                 | Collect from multiple mihomo backends **simultaneously**; data partitioned per backend                                                                                                             |
| Bundled mode (`/__collector` proxy + single container) | **Removed entirely**                                                                                                                                                                               |
| Backend identity                                       | **Normalized mihomo URL** (no user-assigned names)                                                                                                                                                 |
| Auth                                                   | **Single API key**, `Authorization: Bearer <key>`, via `COLLECTOR_TOKEN` env — **required** (collector refuses to start without it)                                                                |
| Backend registration                                   | Dashboard auto-registers via `POST /api/connect` (add-to-set semantics); registered backends **persisted in SQLite**, reconnected on restart; optional env seed (`MIHOMO_API_URL`/`MIHOMO_SECRET`) |
| Backend management                                     | Simple: `GET /api/backends` (list + status) and `DELETE /api/backends` (stop collecting + delete data); minimal management UI in dashboard settings                                                |
| Storage layout                                         | **Single SQLite DB** with a `backend` column (Approach A), not per-backend DB files                                                                                                                |
| Packaging                                              | Same image for both services; compose `command:` override for the collector (restore the 67b19c5 pattern); **no `ports:` published** — Coolify attaches domains directly                           |

## Architecture

```
Coolify (reverse proxy + domains + TLS)
 ├── dashboard.example.com  → metacubexd container :80
 └── collector.example.com  → collector container :9797
Browser ── HTTPS + Bearer key ──→ collector domain
Collector ── persistent WS ──→ mihomo backend A, B, C… (simultaneous)
```

- One Docker image contains both the Nuxt server output and the bundled
  collector `.mjs`. The compose file runs it twice: default CMD for the
  dashboard, `command: ['node', '--no-warnings', '/app/collector/index.mjs']`
  for the collector.
- Neither service publishes ports. A named volume (`collector-data`) is mounted
  only on the collector.

## Changes

### 1. Remove the bundled mode

- Delete `server/routes/__collector/[...].ts` (Nitro same-origin proxy).
- `docker-entrypoint.sh`: remove the background collector startup block
  (`ENABLE_COLLECTOR`, `COLLECTOR_PORT`, `COLLECTOR_DB_PATH`, restart loop);
  back to env mapping + `exec` the dashboard.
- `Dockerfile`: unchanged — the image still builds and ships
  `/app/collector/index.mjs` for the compose `command:` override.
- Frontend `collectorBase()`: no `/__collector` fallback; `collectorURL` is
  required when the feature is enabled.

### 2. Collector: auth

- `loadConfig()` requires `COLLECTOR_TOKEN`: empty/missing → log a clear error
  and `process.exit(1)`.
- All endpoints except `GET /api/health` require
  `Authorization: Bearer <token>` (existing check, now always active).
- CORS unchanged: `ALLOWED_ORIGIN` env, default `*`.

### 3. Collector: storage (schema v2)

- New table:
  `backends (url TEXT PRIMARY KEY, secret TEXT NOT NULL, addedAt INTEGER NOT NULL)`.
- `data_usage_logs` gains `backend TEXT NOT NULL`; composite index
  `(backend, timestamp)` replaces the timestamp-only index for queries.
- Migration: on startup, if `data_usage_logs` exists without a `backend`
  column, `ALTER TABLE … ADD COLUMN backend TEXT NOT NULL DEFAULT ''`. Legacy
  rows keep `backend = ''` — invisible to per-backend queries, not deleted.
- Store interface becomes backend-aware: `insertLogs(backend, logs)`,
  `query(backend, start, end)`, `clearBackend(backend)` (logs only),
  `removeBackend(backend)` (logs + registration), `listBackends()`,
  `upsertBackend(url, secret)`, `countByBackend(backend)`, `count()` (global,
  for health), `cleanup(before)` (global, retention).

### 4. Collector: multi-connection collection

- Backend identity: `normalizeBackend(raw)` = `new URL(raw).href` with the
  trailing slash stripped (URL API lowercases scheme/host). Invalid URL → 400
  at the API layer.
- One `MihomoClient` **and one `Tracker` per backend** (connection IDs and
  cumulative totals are per-backend state; sharing a tracker would corrupt
  deltas). Held in a `Map<normalizedUrl, { client, tracker }>`.
- Existing per-client 3s reconnect logic (`mihomo.ts`) is reused unchanged.
- Single 30s flush timer drains every tracker and inserts with its backend tag;
  retention cleanup stays global.
- On startup: load all rows from `backends`, connect each; if
  `MIHOMO_API_URL` is set, upsert it as a seed backend first.
- `POST /api/connect` semantics change from _replace_ to _upsert_: normalize
  URL, insert into `backends` (or update the secret), connect if new,
  reconnect if the secret changed, no-op otherwise.

### 5. Collector: HTTP API

All endpoints except health require the Bearer key.

| Method | Path                             | Behavior                                                                        |
| ------ | -------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/api/health`                    | Public. `{ ok, since, count }`                                                  |
| POST   | `/api/connect`                   | Body `{ url, secret }`. Upsert backend (add to set). 400 on invalid/missing URL |
| GET    | `/api/logs?backend=&start=&end=` | Logs for that backend. 400 if `backend` missing/invalid                         |
| DELETE | `/api/logs?backend=`             | Clear that backend's logs only. 400 if `backend` missing                        |
| GET    | `/api/backends`                  | `[{ url, addedAt, connected, count }]`                                          |
| DELETE | `/api/backends?url=`             | Disconnect, remove registration, delete its logs. 400 if `url` missing          |

### 6. Frontend

- `stores/config.ts`: `collectorURL` defaults to `''` (drop the
  `localhost:9797` prefill); `collectorToken` unchanged.
- Settings UI: enabling Background Collector requires non-empty URL **and**
  key; on enable, probe `GET /api/health` and surface failure.
- `useDataUsageSource`:
  - `collectorBase()` = `configStore.collectorURL` (no fallback).
  - `query`/`clearCollectorData` append
    `backend=<normalized current endpoint URL>`.
  - `configureCollector()` unchanged client-side (server now upserts).
  - Shared `normalizeBackend()` helper mirrors the collector's normalization.
- Backend management UI (settings, collector section, shown when enabled):
  list from `GET /api/backends` (URL, connected status, log count) with a
  per-row remove button calling `DELETE /api/backends`.
- i18n: new en/zh strings for required-field validation, backend list, remove
  action.

### 7. docker-compose.yml

```yaml
services:
  metacubexd:
    build: .
    image: metacubexd:local
    restart: always
    init: true
  collector:
    build: .
    image: metacubexd:local
    restart: always
    init: true
    command: ['node', '--no-warnings', '/app/collector/index.mjs']
    environment:
      PORT: '9797'
      DB_PATH: /data/collector.sqlite
      COLLECTOR_TOKEN: ${COLLECTOR_TOKEN:?set an API key for the collector}
      # MIHOMO_API_URL: 'http://your-mihomo-host:9090'  # optional seed backend
      # MIHOMO_SECRET: 'your-secret'
      # RETENTION_MS: '0'           # 0 = keep forever
      # ALLOWED_ORIGIN: '*'         # tighten to your dashboard origin
    volumes:
      - collector-data:/data
volumes:
  collector-data:
```

No `ports:` on either service — Coolify maps domains to container ports
(dashboard :80, collector :9797) on its proxy network.

## Error handling

- Missing `COLLECTOR_TOKEN` → startup failure with a clear message.
- Invalid URL to `/api/connect`, missing `backend`/`url` params → 400.
- mihomo disconnects → existing per-backend 3s auto-reconnect.
- Collector unreachable from the dashboard → existing fetch error paths.

## Testing

- Collector unit tests: store (per-backend isolation, migration adds the
  column, clear/remove scoping, backends CRUD), server (auth always enforced,
  `backend` param validation, backends list/delete), config (token required),
  index (multi-connection lifecycle: seed + connect + upsert + remove).
- Frontend unit tests: `useDataUsageSource` sends `backend` param; enable
  validation requires URL + key.
- Full `pnpm test` and typecheck pass.

## Out of scope

- Multiple API keys / per-backend keys.
- User-assigned backend names or aliases.
- Migrating legacy (`backend = ''`) rows to a named backend.
- Cross-backend aggregate views in the dashboard.
