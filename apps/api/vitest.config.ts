import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: process.env.NEXO_LOAD ? [process.env.NEXO_LOAD === 'radius' ? 'test/carga-radius.manual.ts' : process.env.NEXO_LOAD === 'sistema' ? 'test/carga-sistema.manual.ts' : 'test/carga.manual.ts'] : ['test/**/*.test.ts'], fileParallelism: false, env: { NEXO_PANEL_RATE_PER_MIN: '100000' },   // o limite por sessão é testado à parte
    globalSetup: ['test/global-setup.ts'], testTimeout: process.env.NEXO_LOAD ? 900_000 : 30_000, hookTimeout: 60_000 },
});
