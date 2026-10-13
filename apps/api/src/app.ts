import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from './auth.js';
import { pool } from './db.js';
import { cadastroRoutes } from './routes/cadastro.js';
import { extraRoutes } from './routes/extras.js';
import { financeRoutes } from './routes/finance.js';
import { identityRoutes } from './routes/identity.js';
import { importRoutes } from './routes/import.js';
import { ipamRoutes } from './routes/ipam.js';
import { crmRoutes } from './routes/crm.js';
import { fieldRoutes } from './routes/field.js';
import { portalRoutes } from './routes/portal.js';
import { networkRoutes } from './routes/network.js';
import { nocRoutes } from './routes/noc.js';
import { oltRoutes } from './routes/olt.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  // Atrás do Caddy (produção) o endereço real vem em X-Forwarded-For; sem proxy, o cabeçalho seria forjável e não é confiado.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024, trustProxy: process.env.NEXO_TRUST_PROXY === '1' });
  app.decorateRequest('ctx', null as any);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError)
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'dados'}: ${i.message}`).join('; ') });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err.code === '23505') return reply.status(409).send({ error: 'registro duplicado: já existe um cadastro com estes dados', detail: err.constraint });
    if (err.code === '23503') return reply.status(400).send({ error: 'referência inválida ou registro em uso', detail: err.constraint });
    if (err.code === '42501') return reply.status(403).send({ error: 'operação não permitida' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    app.log.error(err);
    if (!opts.logger) console.error(err);
    return reply.status(500).send({ error: 'erro interno' });
  });

  // Saúde para monitoramento externo: 200 só com banco acessível.
  app.get('/api/health', async (_req, reply) => {
    try {
      await pool().query('select 1');
      return { ok: true, db: 'ok', demo: process.env.NEXO_DEMO_MODE === '1' };   // demo: a tela de login mostra as contas sintéticas
    } catch {
      return reply.status(503).send({ ok: false, db: 'indisponível' });
    }
  });
  await app.register(identityRoutes);
  await app.register(cadastroRoutes);
  await app.register(extraRoutes);
  await app.register(networkRoutes);
  await app.register(oltRoutes);
  await app.register(ipamRoutes);
  await app.register(fieldRoutes);
  await app.register(crmRoutes);
  await app.register(nocRoutes);
  await app.register(financeRoutes);
  await app.register(portalRoutes);
  await app.register(importRoutes);

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'rota não encontrada' }) : reply.sendFile('index.html'));
  }
  return app;
}
