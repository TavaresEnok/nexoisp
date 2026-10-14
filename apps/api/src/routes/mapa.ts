import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

/**
 * Mapa geográfico: contratos (local de instalação), caixas ópticas e POPs, só dentro do retângulo visível.
 * O recorte por POP do usuário vem da própria política do banco (contratos); o que não é dele nem aparece.
 */
const MAX_POINTS = 3000;
const zLat = z.number().min(-90).max(90), zLng = z.number().min(-180).max(180);

export async function mapaRoutes(app: FastifyInstance) {
  app.get('/api/map/points', { preHandler: guard('contracts:read') }, async (req) => {
    const q = z.object({
      south: z.coerce.number().min(-90).max(90), north: z.coerce.number().min(-90).max(90),
      west: z.coerce.number().min(-180).max(180), east: z.coerce.number().min(-180).max(180),
      layers: z.string().default('contracts,boxes,pops'),
      status: z.enum(['active', 'suspended', 'ended']).optional(),
    }).parse(req.query);
    const layers = new Set(q.layers.split(',').map((s) => s.trim()));
    // Retângulo que cruza a linha de ±180° (raro): west > east
    const lng = q.west <= q.east ? 'longitude between $2 and $4' : '(longitude >= $2 or longitude <= $4)';
    const box = [q.south, q.west, q.north, q.east];
    return withScope(req.ctx.scope, async (c) => {
      const out: Record<string, unknown> = {};
      if (layers.has('contracts')) {
        const rows = (await c.query(
          `select k.id, k.latitude::float8 as lat, k.longitude::float8 as lng, k.status, s.name as subscriber_name, s.id as subscriber_id,
                  coalesce(r.desired_policy, 'active') as policy,
                  concat_ws(', ', nullif(concat_ws(' ', k.install_street, k.install_number), ''), k.install_district, k.install_city) as address
           from contracts k join subscribers s on s.id = k.subscriber_id
           left join service_resources r on r.contract_id = k.id and r.desired_version > 0
           where k.latitude between $1 and $3 and k.${lng}
             and ($5::text is null or case when k.status = 'ended' then 'ended' when r.desired_policy = 'suspended' then 'suspended' else 'active' end = $5)
           order by k.id limit ${MAX_POINTS + 1}`, [...box, q.status ?? null])).rows;
        out.contracts = rows.slice(0, MAX_POINTS);
        out.contracts_truncated = rows.length > MAX_POINTS;
      }
      if (layers.has('boxes')) {
        out.boxes = (await c.query(
          `select id, latitude::float8 as lat, longitude::float8 as lng, name, kind, ports, address from ftth_boxes
           where latitude between $1 and $3 and ${lng} order by name limit ${MAX_POINTS}`, box)).rows;
      }
      if (layers.has('pops')) {
        out.pops = (await c.query(
          `select id, latitude::float8 as lat, longitude::float8 as lng, name, city from pops
           where active and latitude between $1 and $3 and ${lng} order by name limit 500`, box)).rows;
      }
      return out;
    });
  });

  // Quantos já têm coordenada (e o retângulo que os contém, para o mapa abrir no lugar certo).
  app.get('/api/map/coverage', { preHandler: guard('contracts:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const k = (await c.query(
        `select count(*)::int as total, count(latitude)::int as located,
                min(latitude)::float8 as south, max(latitude)::float8 as north, min(longitude)::float8 as west, max(longitude)::float8 as east
         from contracts where status = 'active'`)).rows[0];
      const b = (await c.query('select count(*)::int as total, count(latitude)::int as located from ftth_boxes')).rows[0];
      const p = (await c.query('select count(*)::int as total, count(latitude)::int as located from pops where active')).rows[0];
      return { contracts: k, boxes: b, pops: p };
    }));

  const put = (table: 'contracts' | 'pops', perm: string, action: string) =>
    app.put(`/api/${table}/:id/location`, { preHandler: guard(perm) }, async (req) => {
      const id = zUuid.parse((req.params as any).id);
      const b = z.object({ latitude: zLat.nullable(), longitude: zLng.nullable() })
        .refine((v) => (v.latitude === null) === (v.longitude === null), 'informe latitude e longitude juntas').parse(req.body);
      return withScope(req.ctx.scope, async (c) => {
        const r = (await c.query(`update ${table} set latitude = $2, longitude = $3 where id = $1 returning id`, [id, b.latitude, b.longitude])).rows[0];
        if (!r) throw new HttpError(404, 'não encontrado');
        await audit(c, req.ctx, action, table === 'pops' ? 'pop' : 'contract', id, b);
        return b;
      });
    });
  put('contracts', 'contracts:write', 'contract.location');
  put('pops', 'network:write', 'pop.location');
}
