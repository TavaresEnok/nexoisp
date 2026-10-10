import { authenticator } from 'otplib';
import { describe, expect, it } from 'vitest';
import { call, getApp, login } from './helpers.js';

const rawLogin = async (email: string, extra: object = {}) => {
  const r = await (await getApp()).inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', ...extra } });
  return { status: r.statusCode, body: r.json() };
};

describe('MFA administrativo', () => {
  it('conta com MFA exige código válido; exigência global bloqueia admin sem MFA', async () => {
    const email = 'noc@beta.demo';
    const t = await login(email);
    const s = (await call(t, 'POST', '/api/me/mfa/setup')).body;
    expect((await call(t, 'POST', '/api/me/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await call(t, 'POST', '/api/me/mfa/enable', { code: authenticator.generate(s.secret) })).status).toBe(200);
    expect((await rawLogin(email)).body).toMatchObject({ code: 'mfa_required' });
    expect((await rawLogin(email, { code: '123456' })).status).toBe(401);
    const ok = await rawLogin(email, { code: authenticator.generate(s.secret) });
    expect(ok.status).toBe(200);
    expect((await call(ok.body.token, 'GET', '/api/me')).body.mfa_enabled).toBe(true);

    process.env.NEXO_REQUIRE_ADMIN_MFA = '1';
    try {
      const admin = await login('admin@beta.demo');
      expect((await call(admin, 'GET', '/api/subscribers')).body).toMatchObject({ code: 'mfa_setup_required' });
      expect((await call(admin, 'GET', '/api/me')).body.mfa_pending).toBe(true);
      expect((await call(ok.body.token, 'GET', '/api/devices')).status).toBe(200); // papel não administrativo segue normal
    } finally {
      delete process.env.NEXO_REQUIRE_ADMIN_MFA;
    }
  });
});
