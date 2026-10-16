import pg from 'pg';
import { env } from './env.js';

pg.types.setTypeParser(1082, (v) => v); // date como string YYYY-MM-DD
pg.types.setTypeParser(20, (v) => Number(v)); // bigint (ids/contagens pequenas)

let _pool: pg.Pool | undefined;
export function pool(): pg.Pool {
  return (_pool ??= new pg.Pool({ connectionString: env.dbApp(), max: 10 }));
}
export async function closePool() {
  await _pool?.end();
  _pool = undefined;
}

export interface DbScope {
  tenantId: string | null;
  operator: boolean;
  /** sessão do portal: restringe as linhas ao próprio assinante (políticas restritivas) */
  subscriberId?: string | null;
  /** usuário restrito a POPs: só contratos desses POPs (e os sem POP) e o que depende deles */
  popIds?: string[] | null;
}
export type Tx = pg.PoolClient;

/** Transação curta com o contexto de tenant aplicado via set_config local (some no commit/rollback). */
export async function withScope<T>(scope: DbScope, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('app.tenant_id', $1, true), set_config('app.is_operator', $2, true), set_config('app.subscriber_id', $3, true), set_config('app.pop_ids', $4, true)`,
      [scope.tenantId ?? '', scope.operator ? 'on' : 'off', scope.subscriberId ?? '', scope.popIds?.length ? scope.popIds.join(',') : '']);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
export const noScope: DbScope = { tenantId: null, operator: false };

/** Paginação opcional: ?limit=&offset=. O total vai no cabeçalho X-Total-Count; o corpo continua sendo a lista. */
export async function paged(c: Tx, reply: { header: (k: string, v: string) => unknown }, sql: string, params: unknown[], q: { limit?: number; offset?: number }, max = 500) {
  // exportação CSV aceita páginas maiores; a tela fica limitada a `max`
  const cap = (reply as any).request?.query?.format === 'csv' ? 5000 : max;
  const limit = Math.min(q.limit ?? cap, cap), offset = q.offset ?? 0;
  // Página e total separados: com `count(*) over()` o banco precisa montar TODAS as linhas (com todas as colunas calculadas) antes
  // de cortar a página. Assim a página sai do índice/ordenação parcial e o total conta sem as colunas que ninguém lê.
  const rows = (await c.query(`select x.* from (${sql}) x limit ${limit} offset ${offset}`, params)).rows;
  const total = offset === 0 && rows.length < limit ? rows.length : Number((await c.query(`select count(*) as n from (${sql}) x`, params)).rows[0].n);
  reply.header('x-total-count', String(total));
  return rows;
}

/** Próximo número sequencial do provedor para a chave (OS, protocolo). Dentro da transação: não deixa buraco se ela falhar. */
export async function nextNumber(c: Tx, tenantId: string, key: string): Promise<number> {
  return (await c.query(
    `insert into tenant_counters (tenant_id, key, value) values ($1,$2,1)
     on conflict (tenant_id, key) do update set value = tenant_counters.value + 1 returning value`, [tenantId, key])).rows[0].value;
}
