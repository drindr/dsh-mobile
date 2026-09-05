import { defineConfig } from 'vitest/config'

/** Tests import the installed @deepseek-ai packages directly (0.1.2 devDeps);
 *  no monorepo src aliases — the built-in browser bundles are loader-wrapped
 *  and not importable here, so specs stub the service faces they inject. */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    pool: 'threads',
  },
})
