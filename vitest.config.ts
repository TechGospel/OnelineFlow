import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'services/**/*.test.ts'],
    environment: 'node',
    // Money and idempotency logic is pure; a slow test here means something is
    // reaching the network, which it should not be.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/main.ts', '**/index.ts'],
      thresholds: {
        // Enforced on the pure domain logic, which is where correctness lives.
        // Wiring code (main.ts) is excluded above and covered by integration.
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
    },
  },
  resolve: {
    // Resolve workspace packages to source so tests do not require a build step
    // and coverage maps back to the real files.
    alias: {
      '@onelineflow/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@onelineflow/crypto': new URL('./packages/crypto/src/index.ts', import.meta.url).pathname,
      '@onelineflow/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@onelineflow/qbo': new URL('./packages/qbo/src/index.ts', import.meta.url).pathname,
      '@onelineflow/ai': new URL('./packages/ai/src/index.ts', import.meta.url).pathname,
      '@onelineflow/queue': new URL('./packages/queue/src/index.ts', import.meta.url).pathname,
      '@onelineflow/storage': new URL('./packages/storage/src/index.ts', import.meta.url).pathname,
      '@onelineflow/observability': new URL(
        './packages/observability/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
});
