#!/bin/sh

set -eu

# Map DEFAULT_BACKEND_URL to Nuxt runtime config env var.
# Nitro embeds public asset metadata at build time, so do not rewrite config.js.
export NUXT_PUBLIC_DEFAULT_BACKEND_URL="${DEFAULT_BACKEND_URL:-}"

exec node /app/.output/server/index.mjs
