import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: process.env.NEXO_LOAD ? ['test/carga.manual.ts'] : ['test/**/*.test.ts'], fileParallelism: false, globalSetup: ['test/global-setup.ts'], testTimeout: 30_000, hookTimeout: 60_000 },
});
