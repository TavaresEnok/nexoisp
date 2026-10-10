import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope, type Tx } from '../db.js';
import { sweep } from '../network/engine.js';
import { zUuid } from '../validators.js';
import { AGENT_OFFLINE_S, RESOURCE_SELECT } from './network.js';

/**
 * Expansão 5: NOC e diagnóstico assistido. Tudo aqui é LEITURA: nenhum alerta ou diagnóstico altera a rede.
 * As conclusões são regras fixas sobre dados já coletados, e cada uma traz a evidência e a data em que foi lida.
 */
const STALE_MIN = 10;          // leitura mais antiga que isso é tratada como desatualizada
type Severity = 'critical' | 'warning' | 'info';
interface Alert { severity: Severity; kind: string; title: string; detail?: string; link?: string; items?: unknown[] }
interface Finding { severity: Severity | 'ok'; code: string; title: string; evidence: { label: string; value: string; at?: string | null }[]; suggestion?: string }
const RANK: Record<string, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

async function nocSettings(c: Tx, tenantId: string) {
  const s = (await c.query('select onu_rx_min_dbm, pon_outage_min, onu_remove_on_contract_end from tenant_settings where tenant_id = $1', [tenantId])).rows[0];
  return { onu_rx_min_dbm: s?.onu_rx_min_dbm == null ? null : Number(s.onu_rx_min_dbm), pon_outage_min: s?.pon_outage_min ?? 3,
    onu_remove_on_contract_end: s?.onu_remove_on_contract_end ?? false };
}
const ONU_BASE = `
  select n.id, n.serial, n.contract_id, n.device_id, n.pon_port, n.observed_state, n.observed_online, n.observed_rx_dbm, n.observed_tx_dbm, n.observed_at,
         n.desired_state, n.desired_version, n.observed_version, d.name as device_name, d.maintenance, s.name as subscriber_name,
         (a.last_seen_at is not null and a.last_seen_at > now() - interval '${AGENT_OFFLINE_S} seconds') as agent_online
  from onus n join devices d on d.id = n.device_id join contracts k on k.id = n.contract_id join subscribers s on s.id = k.subscriber_id
  left join agents a on a.id = d.agent_id`;
/** ONUs autorizadas agrupadas por porta PON, com quantas estão sem sinal. */
const PON_GROUPS = `
  select n.device_id, d.name as device_name, n.pon_port, count(*)::int as total,
         count(*) filter (where n.observed_state = 'absent' or n.observed_online is false)::int as down, max(n.observed_at) as read_at
  from onus n join devices d on d.id = n.device_id
  where n.desired_state = 'authorized' and n.observed_at is not null group by n.device_id, d.name, n.pon_port`;
/** Falha coletiva: pelo menos o mínimo configurado e pelo menos metade das ONUs da porta. É uma heurística, não uma medição. */
const outage = (g: { total: number; down: number }, min: number) => g.down >= min && g.down * 2 >= g.total;

export async function nocRoutes(app: FastifyInstance) {
  app.get('/api/noc/settings', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => nocSettings(c, req.ctx.tenantId!)));

  app.put('/api/noc/settings', { preHandler: guard('network:write') }, async (req) => {
    const b = z.object({ onu_rx_min_dbm: z.number().min(-40).max(0).nullable(), pon_outage_min: z.number().int().min(2).max(500),
      onu_remove_on_contract_end: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      await c.query(
        `insert into tenant_settings (tenant_id, onu_rx_min_dbm, pon_outage_min, onu_remove_on_contract_end, updated_by) values ($1,$2,$3,coalesce($4, false),$5)
         on conflict (tenant_id) do update set onu_rx_min_dbm = excluded.onu_rx_min_dbm, pon_outage_min = excluded.pon_outage_min,
           onu_remove_on_contract_end = coalesce($4, tenant_settings.onu_remove_on_contract_end), updated_by = excluded.updated_by, updated_at = now()`,
        [req.ctx.tenantId, b.onu_rx_min_dbm, b.pon_outage_min, b.onu_remove_on_contract_end ?? null, req.ctx.userId]);
      await audit(c, req.ctx, 'noc.settings_update', 'tenant_settings', req.ctx.tenantId, b);
      return nocSettings(c, req.ctx.tenantId!);
    });
  });

  app.get('/api/noc/overview', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      await sweep(c);
      const cfg = await nocSettings(c, req.ctx.tenantId!);
      const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
      const agents = await q(`select id, name, last_seen_at from agents where status = 'active' and (last_seen_at is null or last_seen_at <= now() - interval '${AGENT_OFFLINE_S} seconds') order by name`);
      const maintenance = await q('select id, name from devices where maintenance order by name');
      const ops = await q(
        `select o.id, o.action, o.status, o.note, o.updated_at, coalesce(r.pppoe_username, 'ONU ' || n.serial) as target, coalesce(r.contract_id, n.contract_id) as contract_id
         from operations o left join service_resources r on r.id = o.resource_id left join onus n on n.id = o.onu_id
         where o.status = 'UNCERTAIN' or (o.status in ('FAILED','EXPIRED') and o.finished_at > now() - interval '24 hours') order by (o.status = 'UNCERTAIN') desc, o.updated_at desc limit 30`);
      const pons = await q(`${PON_GROUPS} order by 2, 3`);
      const down = await q(`${ONU_BASE} where n.desired_state = 'authorized' and n.observed_at is not null and (n.observed_state = 'absent' or n.observed_online is false) order by n.observed_at desc limit 200`);
      const weak = cfg.onu_rx_min_dbm == null ? [] : await q(
        `${ONU_BASE} where n.desired_state = 'authorized' and n.observed_online and n.observed_rx_dbm < $1 order by n.observed_rx_dbm limit 100`, [cfg.onu_rx_min_dbm]);
      const boxes = await q(
        `select b.id, b.name, count(*)::int as total, count(*) filter (where n.observed_state = 'absent' or n.observed_online is false)::int as down
         from ftth_drops x join ftth_boxes b on b.id = x.box_id join onus n on n.contract_id = x.contract_id
         where n.desired_state = 'authorized' and n.observed_at is not null group by b.id, b.name having count(*) >= 2`);
      const n = (await c.query(
        `select (select count(*) from (${RESOURCE_SELECT}) x where x.drift)::int as drift,
                (select count(*) from onus where desired_state = 'authorized')::int as onus,
                (select count(*) from onus n2 join devices d2 on d2.id = n2.device_id join agents a2 on a2.id = d2.agent_id
                  where n2.desired_state = 'authorized' and a2.last_seen_at > now() - interval '${AGENT_OFFLINE_S} seconds'
                    and (n2.observed_at is null or n2.observed_at < now() - interval '${STALE_MIN} minutes'))::int as stale,
                (select count(*) from service_resources where desired_version > 0)::int as accounts,
                (select count(*) from service_resources where desired_policy = 'suspended')::int as suspended,
                (select count(*) from service_resources where (observed_session->>'online')::boolean is true)::int as sessions,
                (select count(*) from work_orders where status in ('open','scheduled','in_progress'))::int as work_orders,
                (select count(*) from work_orders where status in ('open','scheduled') and scheduled_for < now())::int as work_orders_late,
                (select count(*) from tickets where status <> 'closed' and category = 'technical')::int as tickets_technical`)).rows[0];

      const alerts: Alert[] = [];
      const out = pons.filter((g) => outage(g, cfg.pon_outage_min));
      const inOutage = new Set(out.map((g) => `${g.device_id}|${g.pon_port}`));
      for (const a of agents)
        alerts.push({ severity: 'critical', kind: 'agent_offline', title: `Agente “${a.name}” offline`, link: '/rede',
          detail: a.last_seen_at ? `Último contato em ${new Date(a.last_seen_at).toISOString()}. Leituras e operações desse site estão paradas; o RADIUS local segue autenticando.` : 'Nunca se conectou.' });
      for (const g of out)
        alerts.push({ severity: 'critical', kind: 'pon_outage', title: `Possível falha coletiva na PON ${g.pon_port} de ${g.device_name}`, link: '/onus',
          detail: `${g.down} de ${g.total} ONUs sem sinal (heurística: pelo menos ${cfg.pon_outage_min} e metade da porta). Última leitura em ${new Date(g.read_at).toISOString()}.` });
      for (const b of boxes.filter((b) => b.down === b.total))
        alerts.push({ severity: 'critical', kind: 'box_down', title: `Caixa ${b.name}: todas as ${b.total} ONUs sem sinal`, link: '/ftth' });
      const uncertain = ops.filter((o) => o.status === 'UNCERTAIN'), failed = ops.filter((o) => o.status !== 'UNCERTAIN');
      if (uncertain.length) alerts.push({ severity: 'critical', kind: 'ops_uncertain', title: `${uncertain.length} operação(ões) com resultado incerto`, link: '/operacoes?filter=problem',
        detail: 'O equipamento fica bloqueado para novas escritas até o agente verificar o que foi aplicado.', items: uncertain });
      const isolated = down.filter((o) => !inOutage.has(`${o.device_id}|${o.pon_port}`));
      if (isolated.length) alerts.push({ severity: 'warning', kind: 'onu_down', title: `${isolated.length} ONU(s) sem sinal fora de falha coletiva`, link: '/onus', items: isolated.slice(0, 50) });
      if (weak.length) alerts.push({ severity: 'warning', kind: 'onu_weak', title: `${weak.length} ONU(s) com sinal abaixo de ${cfg.onu_rx_min_dbm} dBm`, link: '/onus', items: weak });
      if (n.drift) alerts.push({ severity: 'warning', kind: 'drift', title: `${n.drift} conta(s) PPPoE divergentes da intenção`, link: '/operacoes?filter=problem', detail: 'Possível alteração manual no RADIUS/NAS. Nada é corrigido sozinho.' });
      if (failed.length) alerts.push({ severity: 'warning', kind: 'ops_failed', title: `${failed.length} operação(ões) falharam ou expiraram em 24 h`, link: '/operacoes?filter=problem', items: failed });
      if (n.work_orders_late) alerts.push({ severity: 'warning', kind: 'os_late', title: `${n.work_orders_late} ordem(ns) de serviço com agendamento vencido`, link: '/ordens-servico' });
      if (n.stale) alerts.push({ severity: 'info', kind: 'stale', title: `${n.stale} ONU(s) sem leitura há mais de ${STALE_MIN} min com o agente online` });
      for (const d of maintenance) alerts.push({ severity: 'info', kind: 'maintenance', title: `${d.name} em modo manutenção`, detail: 'O ERP não envia escritas a este equipamento.', link: '/rede' });
      alerts.sort((x, y) => RANK[x.severity] - RANK[y.severity]);
      return { generated_at: new Date().toISOString(), settings: cfg, counters: { ...n, onus_down: down.length, agents_offline: agents.length }, alerts,
        pons: pons.map((g) => ({ ...g, outage: outage(g, cfg.pon_outage_min) })) };
    }));

  /** Início: só o que pede ação de quem está logado, conforme as permissões. Lista vazia = nada pendente. */
  app.get('/api/today', { preHandler: guard('subscribers:read') }, async (req) => {
    const has = (p: string) => req.ctx.perms.includes(p);
    return withScope(req.ctx.scope, async (c) => {
      const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
      const items: { n: number | string; title: string; detail?: string; link: string; severity: Severity }[] = [];
      const add = (n: number, severity: Severity, one: string, many: string, link: string, detail?: string) => { if (n > 0) items.push({ n, title: n === 1 ? one : many, detail, link, severity }); };
      if (has('network:read')) {
        const r = await one(
          `select (select count(*) from agents where status = 'active' and (last_seen_at is null or last_seen_at <= now() - interval '${AGENT_OFFLINE_S} seconds'))::int as agents,
                  (select count(*) from operations where status = 'UNCERTAIN')::int as uncertain,
                  (select count(*) from operations where status in ('FAILED','EXPIRED') and finished_at > now() - interval '24 hours')::int as failed,
                  (select count(*) from onus where desired_state = 'authorized' and observed_at is not null and (observed_state = 'absent' or observed_online is false))::int as onus`);
        add(r.agents, 'critical', 'agente offline', 'agentes offline', '/noc', 'Leituras e operações desse site estão paradas.');
        add(r.uncertain, 'critical', 'operação com resultado incerto', 'operações com resultado incerto', '/operacoes?filter=problem', 'O equipamento fica bloqueado até a verificação.');
        add(r.onus, 'warning', 'ONU sem sinal', 'ONUs sem sinal', '/noc');
        add(r.failed, 'warning', 'operação falhou ou expirou em 24 h', 'operações falharam ou expiraram em 24 h', '/operacoes?filter=problem');
      }
      if (has('crm:read')) {
        const r = await one(`select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'open' and assignee_id = $1)::int as mine,
                                    (select count(*) from leads where stage = 'new')::int as leads from tickets`, [req.ctx.userId]);
        add(r.open, 'warning', 'atendimento aguardando resposta do provedor', 'atendimentos aguardando resposta do provedor', '/atendimentos', r.mine ? `${r.mine} com você.` : undefined);
        add(r.leads, 'info', 'prospecto novo sem contato', 'prospectos novos sem contato', '/prospectos');
      }
      if (has('os:read')) {
        const r = await one(`select count(*) filter (where status in ('open','scheduled') and scheduled_for < now())::int as late,
                                    count(*) filter (where status in ('open','scheduled','in_progress') and assignee_id = $1)::int as mine,
                                    count(*) filter (where status = 'open' and assignee_id is null)::int as unassigned from work_orders`, [req.ctx.userId]);
        add(r.late, 'warning', 'ordem de serviço com agendamento vencido', 'ordens de serviço com agendamento vencido', '/ordens-servico');
        add(r.mine, 'info', 'ordem de serviço em aberto com você', 'ordens de serviço em aberto com você', '/meu-trabalho');
        add(r.unassigned, 'info', 'ordem de serviço sem responsável', 'ordens de serviço sem responsável', '/ordens-servico');
      }
      if (has('finance:read')) {
        const r = await one(
          `select count(*) filter (where i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date)::int as overdue,
                  coalesce(sum(i.amount_cents) filter (where i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date), 0)::int as overdue_cents,
                  count(*) filter (where i.status = 'reconciling')::int as reconciling
           from invoices i left join tenant_settings ts on ts.tenant_id = i.tenant_id`);
        add(r.reconciling, 'warning', 'fatura em conciliação', 'faturas em conciliação', '/conciliacao', 'Pagamento divergente aguardando decisão.');
        add(r.overdue, 'info', 'fatura vencida', 'faturas vencidas', '/faturas', `Total de ${(r.overdue_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`);
      }
      if (has('stock:read')) {
        const r = await one(`select count(*)::int as low from stock_items i where i.active and coalesce((select sum(m.qty) from stock_movements m where m.item_id = i.id), 0) < i.min_qty`);
        add(r.low, 'info', 'item de estoque abaixo do mínimo', 'itens de estoque abaixo do mínimo', '/estoque');
      }
      items.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
      return { name: req.ctx.name, items };
    });
  });

  /** Diagnóstico de um contrato: junta o que o sistema já sabe e aponta a causa mais provável, sempre com a evidência. */
  app.get('/api/contracts/:id/diagnosis', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const seeFinance = req.ctx.perms.includes('finance:read');
    return withScope(req.ctx.scope, async (c) => {
      await sweep(c);
      const k = (await c.query('select k.status, k.end_date, s.name as subscriber_name from contracts k join subscribers s on s.id = k.subscriber_id where k.id = $1', [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      const cfg = await nocSettings(c, req.ctx.tenantId!);
      const r = (await c.query(`select * from (${RESOURCE_SELECT}) x where x.contract_id = $1`, [id])).rows[0];
      const onu = (await c.query(`${ONU_BASE} where n.contract_id = $1`, [id])).rows[0];
      const lastOp = (await c.query(
        `select o.action, o.status, o.note, o.updated_at from operations o
         where (o.resource_id = $1 or o.onu_id = $2) order by o.created_at desc, o.desired_version desc limit 1`, [r?.id ?? null, onu?.id ?? null])).rows[0];
      const pon = onu ? (await c.query(`select * from (${PON_GROUPS}) g where g.device_id = $1 and g.pon_port = $2`, [onu.device_id, onu.pon_port])).rows[0] : null;
      const drop = (await c.query('select b.name as box_name, x.port from ftth_drops x join ftth_boxes b on b.id = x.box_id where x.contract_id = $1', [id])).rows[0];
      const fin = seeFinance ? (await c.query(
        `select count(*) filter (where i.status = 'open')::int as open,
                count(*) filter (where i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date)::int as overdue,
                min(i.due_date) filter (where i.status = 'open') as oldest_due
         from invoices i left join tenant_settings ts on ts.tenant_id = i.tenant_id where i.contract_id = $1`, [id])).rows[0] : null;
      const open = (await c.query(
        `select (select count(*) from work_orders where contract_id = $1 and status in ('open','scheduled','in_progress'))::int as work_orders,
                (select count(*) from tickets t join contracts k2 on k2.subscriber_id = t.subscriber_id where k2.id = $1 and t.status <> 'closed')::int as tickets`, [id])).rows[0];

      const f: Finding[] = [];
      const iso = (v: any) => (v ? new Date(v).toISOString() : null);
      const stale = (at: any) => !at || Date.now() - new Date(at).getTime() > STALE_MIN * 60_000;
      if (k.status !== 'active')
        f.push({ severity: 'info', code: 'contract_ended', title: 'Contrato encerrado', evidence: [{ label: 'Encerrado em', value: String(k.end_date ?? '—') }],
          suggestion: onu?.desired_state === 'authorized' ? 'A ONU continua autorizada na OLT: desautorize se o equipamento foi retirado.' : undefined });
      if (!r || r.desired_version === 0)
        f.push({ severity: 'info', code: 'not_provisioned', title: 'Acesso PPPoE ainda não provisionado', evidence: [],
          suggestion: k.status === 'active' ? 'Use “Provisionar acesso” no contrato.' : undefined });
      if (r) {
        const ev = [{ label: 'Intenção', value: `${r.desired_policy} · perfil ${r.desired_profile} · v${r.desired_version}`, at: iso(r.desired_at) },
          { label: 'Lido no RADIUS/NAS', value: r.observed_at ? `${r.observed_policy}${r.observed_profile ? ` · perfil ${r.observed_profile}` : ''}` : 'nunca lido', at: iso(r.observed_at) }];
        if (!r.agent_online)
          f.push({ severity: 'critical', code: 'agent_offline', title: `Agente ${r.agent_name ? `“${r.agent_name}” ` : ''}offline: os dados abaixo podem estar desatualizados`,
            evidence: [{ label: 'Último contato do agente', value: r.agent_last_seen ? 'ver data' : 'nunca', at: iso(r.agent_last_seen) }],
            suggestion: 'Verifique o servidor do agente no provedor. O RADIUS local continua autenticando com a última política conhecida.' });
        if (r.maintenance) f.push({ severity: 'info', code: 'maintenance', title: `Equipamento ${r.device_name} em modo manutenção: operações aguardam`, evidence: [] });
        if (lastOp && ['UNCERTAIN', 'FAILED', 'EXPIRED'].includes(lastOp.status))
          f.push({ severity: lastOp.status === 'UNCERTAIN' ? 'critical' : 'warning', code: 'operation_problem', title: `Última operação (${lastOp.action}) terminou como ${lastOp.status}`,
            evidence: [{ label: 'Nota', value: lastOp.note ?? '—', at: iso(lastOp.updated_at) }],
            suggestion: lastOp.status === 'UNCERTAIN' ? 'Aguarde o agente verificar o que foi aplicado; não repita manualmente.' : 'Veja as evidências da operação e use “Reaplicar”.' });
        if (r.desired_version > 0 && r.desired_policy === 'suspended')
          f.push({ severity: 'warning', code: 'suspended', title: `Acesso suspenso pelo sistema${r.desired_reason ? `: ${r.desired_reason}` : ''}`,
            evidence: [...ev, ...(fin ? [{ label: 'Faturas vencidas', value: `${fin.overdue} (mais antiga: ${fin.oldest_due ?? '—'})` }] : [{ label: 'Financeiro', value: 'não visível para o seu perfil' }])],
            suggestion: 'O assinante não navega enquanto a intenção for “suspenso”. Reative pelo contrato ou regularize o pagamento, conforme a política do provedor.' });
        if (r.drift)
          f.push({ severity: 'warning', code: 'drift', title: 'O que está aplicado difere do que o sistema pediu', evidence: ev,
            suggestion: 'Provável alteração manual no RADIUS ou no NAS. Use “Reaplicar” ou ajuste a intenção.' });
        if (r.desired_version > 0 && r.desired_policy === 'active' && r.observed_policy === 'active' && !r.drift) {
          const ses = r.observed_session;
          if (ses?.online) f.push({ severity: 'ok', code: 'session_online', title: 'Sessão PPPoE online', evidence: [{ label: 'Endereço', value: String(ses.ip ?? '—'), at: iso(r.observed_at) }, ...(ses.uptime ? [{ label: 'Tempo de conexão', value: String(ses.uptime) }] : [])] });
          else if (ses?.unknown) f.push({ severity: 'info', code: 'session_unknown', title: 'Não foi possível consultar sessões no NAS', evidence: [{ label: 'Erro', value: String(ses.error ?? '—'), at: iso(r.observed_at) }] });
          else f.push({ severity: 'warning', code: 'no_session', title: 'Acesso liberado, mas sem sessão PPPoE', evidence: ev,
            suggestion: onu ? 'A autorização está correta: veja o estado da ONU abaixo.' : 'A autorização está correta: verifique o roteador do assinante (usuário/senha PPPoE, cabo, energia).' });
        }
      }
      if (onu && onu.desired_state === 'authorized') {
        const ev = [{ label: 'ONU', value: `${onu.serial} · ${onu.device_name} · PON ${onu.pon_port}`, at: iso(onu.observed_at) },
          ...(drop ? [{ label: 'Caixa / porta', value: `${drop.box_name} · ${drop.port}` }] : [])];
        const isDown = onu.observed_at && (onu.observed_state === 'absent' || onu.observed_online === false);
        if (!onu.observed_at) f.push({ severity: 'info', code: 'onu_unread', title: 'ONU ainda não foi lida na OLT', evidence: ev });
        else if (onu.observed_state === 'absent')
          f.push({ severity: 'warning', code: 'onu_absent', title: 'ONU não está autorizada na OLT, embora devesse', evidence: ev, suggestion: 'Possível remoção manual na OLT. Use “Reaplicar” na ONU do contrato.' });
        else if (isDown && pon && outage(pon, cfg.pon_outage_min))
          f.push({ severity: 'critical', code: 'pon_outage', title: 'ONU offline junto com outras da mesma porta PON: provável problema na rede óptica',
            evidence: [...ev, { label: `PON ${onu.pon_port}`, value: `${pon.down} de ${pon.total} ONUs sem sinal`, at: iso(pon.read_at) }],
            suggestion: 'Não adianta visita individual: verifique a fibra de alimentação, o splitter e a porta da OLT.' });
        else if (isDown)
          f.push({ severity: 'warning', code: 'onu_offline', title: 'ONU offline; as vizinhas da mesma PON estão normais: provável problema no endereço do assinante',
            evidence: [...ev, ...(pon ? [{ label: `PON ${onu.pon_port}`, value: `${pon.down} de ${pon.total} ONUs sem sinal`, at: iso(pon.read_at) }] : [])],
            suggestion: 'Confirme energia da ONU e o cabo drop. Se persistir, abra uma ordem de serviço de reparo.' });
        else if (cfg.onu_rx_min_dbm != null && onu.observed_rx_dbm != null && Number(onu.observed_rx_dbm) < cfg.onu_rx_min_dbm)
          f.push({ severity: 'warning', code: 'onu_weak', title: `Sinal óptico abaixo do limite do provedor (${cfg.onu_rx_min_dbm} dBm)`,
            evidence: [...ev, { label: 'RX', value: `${Number(onu.observed_rx_dbm).toFixed(2)} dBm`, at: iso(onu.observed_at) }], suggestion: 'Verifique conectores, emendas e curvatura do drop.' });
        else f.push({ severity: 'ok', code: 'onu_ok', title: 'ONU online na OLT',
          evidence: [...ev, ...(onu.observed_rx_dbm != null ? [{ label: 'RX', value: `${Number(onu.observed_rx_dbm).toFixed(2)} dBm${cfg.onu_rx_min_dbm == null ? ' (o provedor não definiu limite)' : ''}`, at: iso(onu.observed_at) }] : [])] });
        if (onu.agent_online && stale(onu.observed_at) && onu.observed_at)
          f.push({ severity: 'info', code: 'onu_stale', title: `Leitura da ONU com mais de ${STALE_MIN} min`, evidence: [{ label: 'Lida em', value: 'ver data', at: iso(onu.observed_at) }] });
      }
      if (open.work_orders || open.tickets)
        f.push({ severity: 'info', code: 'already_open', title: 'Já há atendimento em andamento para este assinante',
          evidence: [{ label: 'Ordens de serviço abertas', value: String(open.work_orders) }, { label: 'Atendimentos abertos', value: String(open.tickets) }] });
      f.sort((x, y) => RANK[x.severity] - RANK[y.severity]);
      const problems = f.filter((x) => x.severity === 'critical' || x.severity === 'warning');
      return { generated_at: new Date().toISOString(), subscriber_name: k.subscriber_name,
        verdict: problems[0]?.title ?? (f.some((x) => x.severity === 'ok') ? 'Nenhum problema encontrado nos dados disponíveis' : 'Sem dados suficientes para concluir'),
        severity: problems[0]?.severity ?? 'ok', findings: f,
        limits: 'Diagnóstico por regras fixas sobre leituras já coletadas; não testa a conexão em tempo real nem enxerga dentro da casa do assinante.' };
    });
  });
}
