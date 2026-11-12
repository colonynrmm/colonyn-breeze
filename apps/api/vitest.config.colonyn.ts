import { defineConfig } from 'vitest/config';

// Colonyn bridge unit tests: `pnpm --filter @breeze/api exec vitest run --config vitest.config.colonyn.ts`
export default defineConfig({
  test: { include: ['src/colonyn/**/*.test.ts'], environment: 'node' },
});
