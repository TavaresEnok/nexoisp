// Comandos autenticados por cookie precisam do valor CSRF da sessão. Os cenários o
// leem de /api/me, como a aplicação faz; o cookie HttpOnly nunca é enviado como cabeçalho.
const known = new WeakMap();
export async function csrf(context, base) {
  const session = (await context.cookies()).find((cookie) => cookie.name === 'nexo_session')?.value;
  if (!session) return {};
  const cached = known.get(context);
  if (cached?.session === session) return { 'X-Nexo-CSRF': cached.token };
  const response = await context.request.get(`${base}/api/me`);
  const token = response.ok() ? (await response.json()).csrf_token ?? '' : '';
  known.set(context, { session, token });
  return { 'X-Nexo-CSRF': token };
}
