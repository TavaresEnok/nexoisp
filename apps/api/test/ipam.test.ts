import { beforeAll, describe, expect, it } from 'vitest';
import { blocks, capacity, forward, reverse, routerosScript } from '../src/network/cgnat.js';
import { call, login } from './helpers.js';

// Expansão IPAM/CGNAT: sobreposição, alocação sem duplicar, cálculo determinístico ida e volta, rastreabilidade e isolamento.
let admin: string, beta: string;
const n = Date.now() % 200;                       // blocos distintos a cada execução do arquivo
const PRIV = `100.${64 + (n % 60)}.${n}.0/24`, PUB = `198.51.${n}.0/30`;

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
});

describe('CGNAT determinístico (cálculo puro)', () => {
  const plan = { id: '11111111-2222-3333-4444-555555555555', name: 't', public_cidr: '198.51.100.0/30', private_cidr: '100.64.0.0/24', ports_per_subscriber: 1000, port_start: 1024 };

  it('cada IP privado tem um bloco exclusivo e a volta devolve o mesmo IP', () => {
    expect(capacity(plan)).toMatchObject({ public_ips: 4, private_ips: 256, blocks_per_public: 64, max_private_ips: 256, fits: true });
    const seen = new Set<string>();
    for (const b of blocks(plan)) {
      expect(b.port_end).toBeLessThanOrEqual(65535);
      for (const port of [b.port_start, b.port_end]) {
        const key = `${b.public_ip}:${port}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(reverse(plan, b.public_ip, port)?.private_ip).toBe(b.private_ip);
      }
    }
    expect(seen.size).toBe(512);
    expect(forward(plan, '100.64.0.64')).toEqual({ private_ip: '100.64.0.64', public_ip: '198.51.100.1', port_start: 1024, port_end: 2023 });
    expect(reverse(plan, '198.51.100.0', 80)).toBeNull();            // abaixo da primeira porta
    expect(reverse(plan, '198.51.100.0', 65500)).toBeNull();         // sobra depois do último bloco
    expect(forward(plan, '100.64.1.0')).toBeNull();
    expect(capacity({ ...plan, ports_per_subscriber: 2000 }).fits).toBe(false);
  });

  it('script para revisão: uma regra TCP e uma UDP por assinante, sem portas repetidas', () => {
    const s = routerosScript(plan);
    expect(s).toContain('GERADO PARA REVISÃO');
    expect(s.match(/protocol=tcp/g)).toHaveLength(256);
    expect(s.match(/protocol=udp/g)).toHaveLength(256);
    expect(s).toContain('src-address=100.64.0.0-100.64.0.63 action=src-nat to-addresses=198.51.100.0');
    expect(s).not.toMatch(/["\n]\s*;|\/system|\/user/);
  });
});

describe('IPAM e CGNAT pela API', () => {
  let priv: any, pub: any, planId: string;

  it('blocos: sobreposição recusada; outro provedor pode usar o mesmo bloco e não vê os deste', async () => {
    priv = (await call(admin, 'POST', '/api/ipam/pools', { name: `cgnat-${n}`, cidr: PRIV, kind: 'cgnat' })).body;
    pub = (await call(admin, 'POST', '/api/ipam/pools', { name: `publico-${n}`, cidr: PUB, kind: 'public' })).body;
    expect(priv.id && pub.id).toBeTruthy();
    const dentro = PRIV.replace('.0/24', '.128/25');
    expect((await call(admin, 'POST', '/api/ipam/pools', { name: `x-${n}`, cidr: dentro, kind: 'private' })).status).toBe(409);
    expect((await call(admin, 'POST', '/api/ipam/pools', { name: `y-${n}`, cidr: PRIV.replace('.0/24', '.5/24'), kind: 'private' })).status).toBe(400);
    expect((await call(beta, 'POST', '/api/ipam/pools', { name: `cgnat-${n}`, cidr: PRIV, kind: 'cgnat' })).status).toBe(200);
    expect((await call(beta, 'GET', '/api/ipam/pools')).body.some((p: any) => p.id === priv.id)).toBe(false);
    expect((await call(beta, 'GET', `/api/ipam/pools/${priv.id}/allocations`)).body).toEqual([]);
    expect((await call(beta, 'POST', `/api/ipam/pools/${priv.id}/allocations`, { description: 'invasão' })).status).toBe(404);
    expect((await call(await login('atendimento@alfa.demo'), 'POST', '/api/ipam/pools', { name: 'z', cidr: '10.9.0.0/24', kind: 'private' })).status).toBe(403);
  });

  it('endereços: escolha automática pula rede e ocupados; duplicado e fora do bloco são recusados', async () => {
    const k = (await call(admin, 'GET', '/api/contracts?status=active')).body[0];
    const base = PRIV.replace('.0/24', '');
    const a1 = await call(admin, 'POST', `/api/ipam/pools/${priv.id}/allocations`, { contract_id: k.id });
    expect(a1.body.address).toBe(`${base}.1`);
    expect((await call(admin, 'POST', `/api/ipam/pools/${priv.id}/allocations`, { description: 'reserva' })).body.address).toBe(`${base}.2`);
    expect((await call(admin, 'POST', `/api/ipam/pools/${priv.id}/allocations`, { address: `${base}.2`, description: 'de novo' })).status).toBe(409);
    expect((await call(admin, 'POST', `/api/ipam/pools/${priv.id}/allocations`, { address: '10.200.0.1', description: 'fora' })).status).toBe(400);
    expect((await call(admin, 'POST', `/api/ipam/pools/${priv.id}/allocations`, {})).status).toBe(400);
    expect((await call(admin, 'GET', `/api/contracts/${k.id}/ips`)).body.map((a: any) => a.address)).toContain(`${base}.1`);
    expect((await call(admin, 'DELETE', `/api/ipam/pools/${priv.id}`)).status).toBe(409);
    // liberar devolve o endereço à escolha automática
    const lista = (await call(admin, 'GET', `/api/ipam/pools/${priv.id}/allocations`)).body;
    await call(admin, 'DELETE', `/api/ipam/allocations/${lista.find((a: any) => a.address === `${base}.2`).id}`);
    expect((await call(admin, 'POST', `/api/ipam/pools/${priv.id}/allocations`, { description: 'outra' })).body.address).toBe(`${base}.2`);
  });

  it('plano de CGNAT: capacidade validada antes de gravar; rastreio devolve o IP privado e o contrato do endereço fixo', async () => {
    const body = { name: `plano-${n}`, public_pool_id: pub.id, private_pool_id: priv.id, ports_per_subscriber: 4000 };
    const nao = await call(admin, 'POST', '/api/cgnat/plans', body);          // 4 públicos × 16 blocos = 64 < 256
    expect(nao.status).toBe(400);
    expect(nao.body.error).toContain('não cabe');
    expect((await call(admin, 'POST', '/api/cgnat/plans/check', { ...body, ports_per_subscriber: 1000 })).body).toMatchObject({ fits: true, blocks_per_public: 64 });
    expect((await call(admin, 'POST', '/api/cgnat/plans', { ...body, public_pool_id: priv.id })).status).toBe(400);   // bloco de saída precisa ser público
    const g = await call(admin, 'POST', '/api/cgnat/plans', { ...body, ports_per_subscriber: 1000 });
    expect(g.status).toBe(200);
    planId = g.body.id;
    expect((await call(admin, 'POST', '/api/cgnat/plans', { ...body, ports_per_subscriber: 1000, name: 'dup' })).status).toBe(409);

    const base = PRIV.replace('.0/24', ''), pubBase = PUB.replace('.0/30', '');
    const t = (await call(admin, 'GET', `/api/cgnat/trace?ip=${pubBase}.0&port=2500`)).body;      // 2º bloco do 1º IP público = privado .1
    expect(t).toMatchObject({ found: true, private_ip: `${base}.1`, public_ip: `${pubBase}.0`, port_start: 2024, port_end: 3023 });
    expect(t.fixed_allocation.contract_id).toBeTruthy();
    expect((await call(admin, 'GET', `/api/cgnat/trace?ip=${pubBase}.0&port=80`)).body.found).toBe(false);
    expect((await call(admin, 'GET', `/api/cgnat/trace?ip=${pubBase}.0&port=2500&at=2020-01-01T00:00:00Z`)).body.found).toBe(false);   // antes de o plano existir
    expect((await call(beta, 'GET', `/api/cgnat/trace?ip=${pubBase}.0&port=2500`)).body.found).toBe(false);
    expect((await call(beta, 'GET', `/api/cgnat/plans/${planId}/map`)).status).toBe(404);

    const script = await call(admin, 'GET', `/api/cgnat/plans/${planId}/script`);
    expect(script.body).toContain(`src-address=${base}.1 protocol=tcp action=src-nat to-addresses=${pubBase}.0 to-ports=2024-3023`);
    expect((await call(await login('atendimento@alfa.demo'), 'GET', `/api/cgnat/plans/${planId}/script`)).status).toBe(403);
    expect((await call(admin, 'GET', '/api/audit')).body.some((e: any) => e.action === 'cgnat.trace')).toBe(true);
  });

  it('plano encerrado continua respondendo consultas da época e libera o bloco para um novo plano', async () => {
    const antes = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(admin, 'POST', `/api/cgnat/plans/${planId}/retire`, {})).status).toBe(200);
    const pubBase = PUB.replace('.0/30', '');
    expect((await call(admin, 'GET', `/api/cgnat/trace?ip=${pubBase}.0&port=2500`)).body.found).toBe(false);
    expect((await call(admin, 'GET', `/api/cgnat/trace?ip=${pubBase}.0&port=2500&at=${encodeURIComponent(antes)}`)).body).toMatchObject({ found: true });
    expect((await call(admin, 'DELETE', `/api/ipam/pools/${pub.id}`)).status).toBe(409);   // mantido para rastreabilidade
    expect((await call(admin, 'POST', '/api/cgnat/plans', { name: `novo-${n}`, public_pool_id: pub.id, private_pool_id: priv.id, ports_per_subscriber: 1000 })).status).toBe(200);
  });
});

describe('IP fixo entregue pelo RADIUS', () => {
  it('alocar e liberar reenviam a intenção com (e sem) o endereço, preservando a suspensão; um IPv4 por contrato', async () => {
    const { testAgent, freeContract } = await import('./helpers.js');
    const ag = await testAgent(admin, `ipfixo-${n}-${Date.now()}`);
    const k = await freeContract(admin, (c) => true);
    const pool = (await call(admin, 'POST', '/api/ipam/pools', { name: `fixos-${n}-${Date.now()}`, cidr: `10.${n}.${Date.now() % 250}.0/24`, kind: 'private' })).body;
    for (const x of (await call(admin, 'GET', `/api/contracts/${k.id}/ips`)).body) await call(admin, 'DELETE', `/api/ipam/allocations/${x.id}`);   // sobra de outro teste
    // sem conta PPPoE: registra, mas nada vai ao equipamento
    const semConta = (await call(admin, 'POST', `/api/ipam/pools/${pool.id}/allocations`, { contract_id: k.id })).body;
    expect(semConta.network).toMatchObject({ requested: false });
    await call(admin, 'DELETE', `/api/ipam/allocations/${semConta.id}`);

    const s = (await call(admin, 'POST', `/api/contracts/${k.id}/service`, { device_id: ag.deviceId, pppoe_username: `ipfixo${Date.now()}` })).body;
    expect((await ag.runNext()).parameters.framed_ip).toBeUndefined();          // sem IP fixo a chave nem existe (agentes antigos continuam aceitando)
    const a = (await call(admin, 'POST', `/api/ipam/pools/${pool.id}/allocations`, { contract_id: k.id })).body;
    expect(a.network).toMatchObject({ requested: true });
    const env = await ag.runNext();
    expect(env).toMatchObject({ action: 'subscriber.resume', operation_id: a.network.operation_id, parameters: { framed_ip: a.address, policy: 'active' } });
    expect((await call(admin, 'POST', `/api/ipam/pools/${pool.id}/allocations`, { contract_id: k.id })).status).toBe(409);

    // suspenso continua suspenso, e a suspensão carrega o endereço
    await call(admin, 'POST', `/api/resources/${s.resource_id}/suspend`, { reason: 'teste' });
    expect((await ag.runNext()).parameters).toMatchObject({ policy: 'suspended', framed_ip: a.address });
    const rel = (await call(admin, 'DELETE', `/api/ipam/allocations/${a.id}`)).body;
    expect(rel.network.requested).toBe(true);
    const env2 = await ag.runNext();
    expect(env2).toMatchObject({ action: 'subscriber.suspend', parameters: { policy: 'suspended' } });
    expect('framed_ip' in env2.parameters).toBe(false);
  });
});

describe('IPv6: prefixo delegado por contrato', () => {
  it('escolhe o próximo prefixo livre, não sobrepõe, um por contrato, e não vaza entre provedores', async () => {
    const { ipv6Subnet } = await import('../src/network/cgnat.js');
    expect(ipv6Subnet('2001:db8::/40', 56, 0)).toBe('2001:db8:0:0:0:0:0:0/56');
    expect(ipv6Subnet('2001:db8::/40', 56, 257)).toBe('2001:db8:1:100:0:0:0:0/56');
    const hex = (Date.now() % 0xffff).toString(16);
    const cidr = `2001:db8:${hex}::/48`;
    expect((await call(admin, 'POST', '/api/ipam/pools', { name: `v4-deleg-${hex}`, cidr: `10.250.${Date.now() % 250}.0/24`, kind: 'private', delegation_len: 56 })).status).toBe(400);
    const pool = (await call(admin, 'POST', '/api/ipam/pools', { name: `v6-${hex}`, cidr, kind: 'public', delegation_len: 56 })).body;
    expect(pool.delegation_len).toBe(56);
    const ks = (await call(admin, 'GET', '/api/contracts?status=active')).body;
    for (const k of ks.slice(0, 2)) {
      const cur = (await call(admin, 'GET', `/api/contracts/${k.id}/ipv6`)).body.delegation;
      if (cur) await call(admin, 'DELETE', `/api/ipam/delegations/${cur.id}`);
    }
    const a = (await call(admin, 'POST', `/api/ipam/pools/${pool.id}/delegations`, { contract_id: ks[0].id })).body;
    const b = (await call(admin, 'POST', `/api/ipam/pools/${pool.id}/delegations`, { contract_id: ks[1].id })).body;
    expect([a.prefix, b.prefix]).toEqual([`2001:db8:${hex}::/56`, `2001:db8:${hex}:100::/56`]);
    expect((await call(admin, 'POST', `/api/ipam/pools/${pool.id}/delegations`, { contract_id: ks[0].id })).status).toBe(409);       // um por contrato
    await call(admin, 'DELETE', `/api/ipam/delegations/${a.id}`);
    expect((await call(admin, 'POST', `/api/ipam/pools/${pool.id}/delegations`, { contract_id: ks[0].id, prefix: `2001:db8:${hex}:100::/56` })).status).toBe(409);   // já delegado
    expect((await call(admin, 'POST', `/api/ipam/pools/${pool.id}/delegations`, { contract_id: ks[0].id, prefix: `2001:db8:${hex}:200::/60` })).status).toBe(400);   // tamanho errado
    expect((await call(admin, 'POST', `/api/ipam/pools/${pool.id}/delegations`, { contract_id: ks[0].id, prefix: '2001:db9::/56' })).status).toBe(400);              // fora do bloco
    expect((await call(admin, 'POST', `/api/ipam/pools/${pool.id}/delegations`, { contract_id: ks[0].id })).body.prefix).toBe(`2001:db8:${hex}::/56`);               // o liberado volta
    expect((await call(admin, 'GET', `/api/contracts/${ks[1].id}/ipv6`)).body.delegation.prefix).toBe(`2001:db8:${hex}:100::/56`);
    expect((await call(admin, 'GET', '/api/ipam/pools')).body.find((p: any) => p.id === pool.id).allocated).toBe(2);
    expect((await call(beta, 'GET', `/api/ipam/pools/${pool.id}/delegations`)).body).toEqual([]);
    expect((await call(beta, 'POST', `/api/ipam/pools/${pool.id}/delegations`, { contract_id: ks[0].id })).status).toBe(404);
    expect((await call(admin, 'DELETE', `/api/ipam/pools/${pool.id}`)).status).toBe(409);
  });
});
