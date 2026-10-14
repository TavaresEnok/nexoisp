import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

/**
 * Coleta de acessos da ANATEL (DICI / SCM), mensal. Conta os contratos em serviço no último dia da competência e agrupa por CNPJ,
 * município (código IBGE), tipo de cliente, área, meio, tecnologia e velocidade.
 * O leiaute de saída segue o arquivo de acessos SCM conhecido em 2026 — CONFERIR no Sistema de Coleta de Dados da ANATEL antes de enviar;
 * o sistema não envia nada à ANATEL.
 */
export const TECHNOLOGIES = ['FTTH', 'FTTB', 'HFC', 'XDSL', 'ETHERNET', 'RADIO', 'LTE', 'SATELITE', 'OUTRA'] as const;
const MEIO: Record<string, string> = {
  FTTH: 'fibra', FTTB: 'fibra', HFC: 'cabo_coaxial', XDSL: 'cabo_metalico', ETHERNET: 'cabo_metalico', RADIO: 'radio', LTE: 'radio', SATELITE: 'satelite', OUTRA: 'outro',
};
const meioSql = `case p.access_technology ${Object.entries(MEIO).map(([k, v]) => `when '${k}' then '${v}'`).join(' ')} end`;

/** Contratos em serviço no último dia da competência, com tudo o que a coleta pede (e o que falta para cada um). */
const BASE = `
  with params as (select ($1::date + interval '1 month' - interval '1 day')::date as last_day),
  ativos as (
    select k.id, k.service_area, s.document, coalesce(k.company_id, (select id from companies d where d.is_default and d.active)) as company_id,
           coalesce(nullif(k.install_city, ''), s.address_city) as city, upper(coalesce(nullif(k.install_state, ''), s.address_state)) as state,
           p.access_technology, ${meioSql} as meio, pv.down_kbps
    from contracts k join subscribers s on s.id = k.subscriber_id join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id, params
    where k.start_date <= params.last_day and (k.status = 'active' or k.end_date > params.last_day))
  select a.*, c.document as cnpj, m.ibge_code
  from ativos a left join companies c on c.id = a.company_id
  left join municipalities m on m.state = a.state and norm_city(m.name) = norm_city(a.city)`;

export async function anatelRoutes(app: FastifyInstance) {
  app.get('/api/anatel/dici', { preHandler: guard('settings:manage') }, async (req, reply) => {
    const q = z.object({ competence: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'competência AAAA-MM'), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const comp = `${q.competence}-01`;
    const out = await withScope(req.ctx.scope, async (c) => {
      const rows = (await c.query(
        `select cnpj, ibge_code, case when length(coalesce(document, '')) = 14 then 'PJ' else 'PF' end as tipo_cliente,
                case service_area when 'rural' then 'RURAL' else 'URBANO' end as tipo_atendimento, meio, access_technology as tecnologia,
                round(down_kbps / 1000.0, 2)::float as velocidade_mbps, count(*)::int as acessos
         from (${BASE}) x where cnpj is not null and ibge_code is not null and access_technology is not null
         group by 1, 2, 3, 4, 5, 6, 7 order by 1, 2, 3, 4, 6, 7`, [comp])).rows;
      const pend = (await c.query(
        `select count(*) filter (where cnpj is null)::int as sem_cnpj, count(*) filter (where ibge_code is null)::int as sem_municipio,
                count(*) filter (where access_technology is null)::int as sem_tecnologia, count(*)::int as total
         from (${BASE}) x`, [comp])).rows[0];
      const cities = (await c.query(
        `select city, state, count(*)::int as contratos from (${BASE}) x where ibge_code is null group by 1, 2 order by 3 desc limit 50`, [comp])).rows;
      const plans = (await c.query(
        `select distinct p.id, p.name from plans p join plan_versions pv on pv.plan_id = p.id join contracts k on k.plan_version_id = pv.id
         where p.access_technology is null and k.status = 'active' order by p.name limit 50`)).rows;
      await audit(c, req.ctx, 'anatel.dici', 'report', null, { competence: q.competence, format: q.format, accesses: rows.reduce((s, r) => s + r.acessos, 0) });
      return { competence: q.competence, rows, pending: { ...pend, cities_without_code: cities, plans_without_technology: plans } };
    });
    if (q.format === 'json') return out;
    const [ano, mes] = q.competence.split('-');
    const lines = ['CNPJ;ANO;MES;COD_IBGE;TIPO_CLIENTE;TIPO_ATENDIMENTO;TIPO_MEIO;TIPO_PRODUTO;TIPO_TECNOLOGIA;VELOCIDADE;ACESSOS',
      ...out.rows.map((r: any) => [r.cnpj, ano, mes, r.ibge_code, r.tipo_cliente, r.tipo_atendimento, r.meio, 'internet', r.tecnologia,
        String(r.velocidade_mbps).replace('.', ','), r.acessos].join(';'))];
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="dici-acessos-${q.competence}.csv"`);
    return lines.join('\r\n') + '\r\n';
  });

  // ---- cadastros que a coleta precisa ----
  app.get('/api/anatel/municipalities', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query('select name, state, ibge_code from municipalities order by state, name')).rows));

  app.put('/api/anatel/municipalities', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'UF com 2 letras'),
      ibge_code: z.string().trim().regex(/^[0-9]{7}$/, 'código IBGE com 7 dígitos') }).parse(req.body);
    if (!ufMatches(b.state, b.ibge_code)) throw new HttpError(400, `o código IBGE ${b.ibge_code} não é de ${b.state} (os 2 primeiros dígitos indicam a UF)`);
    return withScope(req.ctx.scope, async (c) => {
      await c.query(`delete from municipalities where state = $1 and norm_city(name) = norm_city($2)`, [b.state, b.name]);
      await c.query('insert into municipalities (tenant_id, name, state, ibge_code) values ($1,$2,$3,$4)', [req.ctx.tenantId, b.name, b.state, b.ibge_code]);
      await audit(c, req.ctx, 'anatel.municipality', 'municipality', null, b);
      return b;
    });
  });

  app.put('/api/plans/:id/technology', { preHandler: guard('plans:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ access_technology: z.enum(TECHNOLOGIES).nullable() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query('update plans set access_technology = $2 where id = $1 returning id, name, access_technology', [id, b.access_technology])).rows[0];
      if (!r) throw new HttpError(404, 'plano não encontrado');
      await audit(c, req.ctx, 'plan.technology', 'plan', id, b);
      return r;
    });
  });

  app.put('/api/contracts/:id/service-area', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ service_area: z.enum(['urban', 'rural']) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query('update contracts set service_area = $2 where id = $1 returning id', [id, b.service_area])).rows[0];
      if (!r) throw new HttpError(404, 'contrato não encontrado');
      await audit(c, req.ctx, 'contract.service_area', 'contract', id, b);
      return b;
    });
  });
}

/** Os 2 primeiros dígitos do código IBGE do município são o código da UF. */
const UF_CODE: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};
const ufMatches = (uf: string, code: string) => UF_CODE[uf] === code.slice(0, 2);
