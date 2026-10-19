import { defineConfig } from 'vitest/config'

// Root-level Vitest config scoped to the standalone collector daemon, which
// lives at the repo root (outside the pnpm workspace packages). The dashboard
// has its own config at packages/ui/vitest.config.ts.
export default defineConfig({
  test: {
    include: ['collector/**/*.spec.ts'],
  },
})
