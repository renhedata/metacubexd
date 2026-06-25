# Dashboard (Nuxt server output) + the standalone background-traffic collector,
# built from the pnpm monorepo. A single image serves both: the default CMD runs
# the dashboard; docker-compose.yml overrides the command for the collector
# service (node /app/collector/index.mjs).
FROM --platform=$BUILDPLATFORM docker.io/node:alpine AS builder

USER root
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
WORKDIR /build

COPY . .

RUN npm install --force -g corepack
RUN corepack enable
RUN corepack install
RUN pnpm install
# Dashboard: nuxt build (SSR/node-server preset) -> packages/ui/.output, which
# contains .output/server/index.mjs that the entrypoint runs.
RUN pnpm --filter @metacubexd/ui build
# Bundle the zero-dependency collector daemon into a single .mjs (plain node).
RUN pnpm build:collector

FROM docker.io/node:alpine

ENV PORT=80
# 80 = dashboard (default CMD); 9797 = collector (compose command override).
# Reverse proxies like Coolify use EXPOSE to auto-detect mappable ports.
EXPOSE 80 9797

WORKDIR /app

# Dashboard (Nuxt server output) + the bundled background-traffic collector.
COPY --from=builder /build/packages/ui/.output ./.output
COPY --from=builder /build/dist/collector ./collector
COPY packages/ui/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

CMD ["/docker-entrypoint.sh"]
