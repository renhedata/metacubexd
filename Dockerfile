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
RUN pnpm build
# Bundle the zero-dependency collector daemon into a single .mjs (run by plain node).
RUN pnpm build:collector

FROM docker.io/node:alpine

ENV PORT=80
EXPOSE 80

WORKDIR /app

# Dashboard (Nuxt server output) + the bundled background-traffic collector.
# The default CMD runs the dashboard; the collector is started by overriding the
# command (see docker-compose.yml): node /app/collector/index.mjs
COPY --from=builder /build/.output ./.output
COPY --from=builder /build/dist/collector ./collector
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

CMD ["/docker-entrypoint.sh"]
