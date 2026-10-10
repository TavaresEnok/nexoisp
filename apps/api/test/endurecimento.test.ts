import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, needsRotation, resetKeyCache } from '../src/network/crypto.js';
import { call, getApp, login } from './helpers.js';

describe('endurecimento', () => {
  it('rotação da chave de segredos: chave anterior só decifra; recifrar passa a usar a atual', () => {
    const [A, B] = [Buffer.alloc(32, 1).toString('base64'), Buffer.alloc(32, 2).toString('base64')];
    const saved = { cur: process.env.NEXO_SECRET_KEY, prev: process.env.NEXO_SECRET_KEY_PREVIOUS };
    try {
      process.env.NEXO_SECRET_KEY = A; delete process.env.NEXO_SECRET_KEY_PREVIOUS; resetKeyCache();
      const old = encryptSecret('senha-pppoe');
      process.env.NEXO_SECRET_KEY = B; resetKeyCache();
      expect(() => decryptSecret(old)).toThrow();                      // sem a chave anterior não abre
      process.env.NEXO_SECRET_KEY_PREVIOUS = A; resetKeyCache();
      expect(decryptSecret(old)).toBe('senha-pppoe');
      expect(needsRotation(old)).toBe(true);
      const fresh = encryptSecret(decryptSecret(old));
      expect(needsRotation(fresh)).toBe(false);
      delete process.env.NEXO_SECRET_KEY_PREVIOUS; resetKeyCache();
      expect(decryptSecret(fresh)).toBe('senha-pppoe');
    } finally {
      if (saved.cur) process.env.NEXO_SECRET_KEY = saved.cur; else delete process.env.NEXO_SECRET_KEY;
      if (saved.prev) process.env.NEXO_SECRET_KEY_PREVIOUS = saved.prev; else delete process.env.NEXO_SECRET_KEY_PREVIOUS;
      resetKeyCache();
    }
  });

  it('sessão por cookie HttpOnly: leitura funciona; escrita sem cabeçalho CSRF é negada', async () => {
    const app = await getApp();
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@alfa.demo', password: 'demo1234' } });
    const set = String(r.headers['set-cookie']);
    expect(set).toMatch(/nexo_session=.+; Path=\/; HttpOnly; SameSite=Strict/);
    const cookie = set.split(';')[0];
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    const body = { name: 'Via Cookie Sem CSRF' };
    expect((await app.inject({ method: 'POST', url: '/api/subscribers', payload: body, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/subscribers', payload: body, headers: { cookie, 'x-nexo-csrf': '1' } })).statusCode).toBe(200);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-nexo-csrf': '1' } });
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('listas paginadas informam o total e respeitam limite/deslocamento', async () => {
    const t = await login('admin@alfa.demo');
    const app = await getApp();
    const get = async (url: string) => { const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${t}` } }); return { total: Number(r.headers['x-total-count']), rows: r.json() as any[] }; };
    const all = await get('/api/subscribers');
    const p1 = await get('/api/subscribers?limit=3&offset=0'), p2 = await get('/api/subscribers?limit=3&offset=3');
    expect(p1.total).toBe(all.total);
    expect(p1.rows).toHaveLength(3);
    expect(p1.rows.map((r) => r.id)).toEqual(all.rows.slice(0, 3).map((r) => r.id));
    expect(p2.rows.map((r) => r.id)).toEqual(all.rows.slice(3, 6).map((r) => r.id));
    expect((await get(`/api/subscribers?limit=3&offset=${all.total + 10}`)).total).toBe(all.total);
    expect((await call(t, 'GET', '/api/subscribers?limit=9999')).status).toBe(400);
  });
});

describe('rotinas periódicas com mais de uma réplica', () => {
  it('duas sessões do banco disputando a trava: só uma executa; a outra pula o ciclo e volta a rodar depois', async () => {
    const { withWorkerLock } = await import('../src/worker.js');
    let dentro = 0, maximo = 0, execucoes = 0;
    let soltar!: () => void;
    const segurando = new Promise<void>((r) => { soltar = r; });
    const trabalho = async () => { dentro++; execucoes++; maximo = Math.max(maximo, dentro); await segurando; dentro--; };
    const primeira = withWorkerLock(trabalho);
    await new Promise((r) => setTimeout(r, 100));               // a primeira "réplica" já está com a trava
    expect(await withWorkerLock(trabalho)).toBe(false);          // a segunda não executa nem espera
    soltar();
    expect(await primeira).toBe(true);
    expect({ execucoes, maximo }).toEqual({ execucoes: 1, maximo: 1 });
    expect(await withWorkerLock(async () => { execucoes++; })).toBe(true);   // trava liberada mesmo após o trabalho anterior
    await expect(withWorkerLock(async () => { throw new Error('falhou'); })).rejects.toThrow('falhou');
    expect(await withWorkerLock(async () => {})).toBe(true);     // falha dentro da rotina não deixa a trava presa
  });
  it('limite de login no banco: bloqueia por e-mail e por endereço, não é zerado por outra réplica e um acerto não apaga a varredura', async () => {
    const { withScope, noScope } = await import('../src/db.js');
    const tag = Date.now();
    const tentar = (email: string, password: string, ip: string) =>
      getApp().then((a) => a.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { email, password } })).then((r) => r.statusCode);
    // 8 falhas no mesmo e-mail (a partir de endereços diferentes): a 9ª é recusada mesmo com a senha certa
    const alvo = `limite${tag}@alfa.demo`;
    for (let i = 0; i < 8; i++) expect(await tentar(alvo, 'errada', `10.99.0.${i + 1}`)).toBe(401);
    expect(await tentar(alvo, 'errada', '10.99.1.1')).toBe(429);
    expect(await tentar('admin@alfa.demo', 'demo1234', '10.99.1.2')).toBe(200);          // outra conta não é afetada
    // o estado está no banco: uma "outra réplica" (nova conexão) vê o mesmo bloqueio
    const wait = await withScope(noScope, async (c) => (await c.query(`select login_throttle_blocked($1, 8) as s`, [`email:${alvo}`])).rows[0].s);
    expect(wait).toBeGreaterThan(0);
    // varredura de e-mails a partir de um só endereço: 40 falhas bloqueiam o endereço, até para uma conta válida
    for (let i = 0; i < 40; i++) await tentar(`varre${tag}${i}@alfa.demo`, 'x', '10.99.2.2');
    expect(await tentar('admin@alfa.demo', 'demo1234', '10.99.2.2')).toBe(429);
    expect(await tentar('admin@alfa.demo', 'demo1234', '10.99.2.3')).toBe(200);          // outro endereço segue normal
    // a aplicação não lê nem escreve a tabela direto
    await expect(withScope(noScope, (c) => c.query('select * from login_throttle'))).rejects.toThrow();
  });
});
