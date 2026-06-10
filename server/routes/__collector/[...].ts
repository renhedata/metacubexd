// Same-origin proxy to the bundled background-traffic collector.
//
// In the single-container deployment the collector runs alongside this Nitro
// server (see docker-entrypoint.sh) on COLLECTOR_INTERNAL_URL. Exposing it here
// lets the browser reach the collector at the dashboard's own origin
// (/__collector/api/...), so users never configure a collector address and no
// extra port needs to be published. Requires the Node server build (the Docker
// image), not `nuxt generate`.
export default defineEventHandler((event) => {
  const target = process.env.COLLECTOR_INTERNAL_URL || 'http://127.0.0.1:9797'
  const subpath = event.path.replace(/^\/__collector/, '') || '/'

  return proxyRequest(event, target + subpath)
})
