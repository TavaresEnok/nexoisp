import { buildAgentApp } from './agent-api.js';
import { buildApp } from './app.js';
import { env } from './env.js';
import { migrate } from './migrate.js';
import { seedDemo } from './seed.js';
import { startWorker } from './worker.js';

if (process.env.DATABASE_URL_OWNER) await migrate();
if (env.demoMode) await seedDemo();
const app = await buildApp({ logger: true });
await app.listen({ host: '0.0.0.0', port: env.port });

const agentApp = await buildAgentApp({ logger: true });
if (agentApp) await agentApp.listen({ host: '0.0.0.0', port: Number(process.env.AGENT_PORT ?? 8443) });
else app.log.warn('API de agentes NÃO iniciada: configure NEXO_AGENT_TLS_DIR (mTLS)');
startWorker((m) => app.log.info(m));
