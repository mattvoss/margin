import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Separate from vite.config.ts: test-only concerns (jsdom) stay out of the
// production build config.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror tsconfig.app.json `@/*` → `./src/*` so shadcn `@/` imports
    // resolve under vitest (vite.config.ts gets this via tsconfigPaths).
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
