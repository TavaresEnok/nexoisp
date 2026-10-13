import type { FastifyInstance } from 'fastify';
import { audit } from './auth.js';

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const t = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // texto que começa com = + - @ viraria fórmula na planilha
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
};

/** CSV com BOM e `;` (abre direto no Excel em português). Colunas = chaves das linhas, sem as internas (`_total`). */
export function autoCsv(rows: Record<string, unknown>[]): string {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!k.startsWith('_') && !cols.includes(k)) cols.push(k);
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n') + '\r\n';
}

/** Listas que aceitam `?format=csv` (a mesma consulta do painel, com o mesmo filtro e a mesma permissão). */
const EXPORTABLE = /^\/api\/(subscribers|contracts|invoices|work-orders|tickets|leads|stock\/items|stock\/units|audit)$/;

export function csvExport(app: FastifyInstance) {
  // onSend: a lista já foi serializada em JSON pelo Fastify; aqui vira CSV (a serialização não aceita trocar o formato antes).
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' || (req.query as any)?.format !== 'csv' || reply.statusCode !== 200 || typeof payload !== 'string') return payload;
    const path = req.url.split('?')[0];
    if (!EXPORTABLE.test(path)) return payload;
    let rows: unknown;
    try { rows = JSON.parse(payload); } catch { return payload; }
    if (!Array.isArray(rows)) return payload;
    await audit(null, req.ctx, 'export.csv', 'list', null, { path, rows: rows.length });
    reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${path.replace(/^\/api\//, '').replace(/\W+/g, '-')}.csv"`);
    return autoCsv(rows as Record<string, unknown>[]);
  });
}
