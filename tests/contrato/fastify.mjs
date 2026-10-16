// Executa o produto sem main.ts (sem workers, seed de demonstração ou listeners de agentes).
import { buildApp } from '../../legacy/fastify/src/app.ts';
import { closePool } from '../../legacy/fastify/src/db.ts';
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 18081) });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  await app.close(); await closePool(); process.exit(0);
});
