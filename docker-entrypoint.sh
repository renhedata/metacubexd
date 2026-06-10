#!/bin/sh

set -eu

# Map DEFAULT_BACKEND_URL to Nuxt runtime config env var.
# Nitro embeds public asset metadata at build time, so do not rewrite config.js.
export NUXT_PUBLIC_DEFAULT_BACKEND_URL="${DEFAULT_BACKEND_URL:-}"

# Start the bundled background-traffic collector alongside the dashboard (unless
# disabled). The dashboard proxies /__collector -> this collector at the same
# origin, so no extra port is published and the user configures no address.
if [ "${ENABLE_COLLECTOR:-true}" = "true" ]; then
  COLLECTOR_PORT="${COLLECTOR_PORT:-9797}"
  COLLECTOR_DB_PATH="${COLLECTOR_DB_PATH:-/data/collector.sqlite}"
  mkdir -p "$(dirname "$COLLECTOR_DB_PATH")"
  (
    while true; do
      PORT="$COLLECTOR_PORT" \
      DB_PATH="$COLLECTOR_DB_PATH" \
      MIHOMO_API_URL="${MIHOMO_API_URL:-}" \
      MIHOMO_SECRET="${MIHOMO_SECRET:-}" \
      RETENTION_MS="${RETENTION_MS:-0}" \
        node --no-warnings /app/collector/index.mjs || true
      echo "[entrypoint] collector exited; restarting in 2s" >&2
      sleep 2
    done
  ) &
fi

# Start the dashboard (foreground; the container's lifecycle follows this).
exec node /app/.output/server/index.mjs
