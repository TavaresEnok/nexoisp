export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}
export type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };
export type HttpResponse<T> = { data: T; total: number | null };
type Proof = { csrf_token: string; session_context: string };
const stale = "A sessão mudou. Entre novamente e refaça a operação.";
export function createApiClient(fetcher: typeof fetch, onUnauthorized: () => void = () => {}) {
  let proof: Proof | null = null;
  let epoch = 0;
  let transitioning = false;
  const invalidate = () => { proof = null; transitioning = false; epoch++; onUnauthorized(); };
  const fail = (): never => { invalidate(); throw new ApiError(409, stale); };
  const ensureCurrent = (start: number) => { if (start !== epoch) throw new ApiError(409, stale); };
  async function fetchResponse(path: string, init: RequestInit) {
    try { return await fetcher(`/api${path}`, { ...init, credentials: "same-origin" }); }
    catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; throw new ApiError(0, "Não foi possível conectar ao servidor. Tente novamente."); }
  }
  function parseProof(data: unknown, res: Response): Proof | null {
    const p = data as Partial<Proof> | null;
    return typeof p?.csrf_token === "string" && p.csrf_token.length > 0 && typeof p.session_context === "string" && p.session_context.length > 0 && res.headers.get("X-Nexo-Context") === p.session_context ? p as Proof : null;
  }
  async function session() {
    const start = epoch;
    const res = await fetchResponse("/me", { headers: { Accept: "application/json" } });
    ensureCurrent(start);
    if (!res.ok) { if (res.status === 401) invalidate(); throw new ApiError(res.status, "Não foi possível confirmar a sessão."); }
    const data: unknown = await res.json();
    ensureCurrent(start);
    const candidate = parseProof(data, res);
    if (!candidate) return fail();
    return { data, accept: () => { ensureCurrent(start); proof = candidate; transitioning = false; epoch++; } };
  }
  async function response(path: string, options: RequestOptions = {}): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) throw new Error("Caminho de API inválido.");
    const method = (options.method ?? (options.body === undefined ? "GET" : "POST")).toUpperCase();
    const unsafe = !["GET", "HEAD"].includes(method);
    const login = path === "/auth/login";
    const publicRead = !unsafe && path === "/health";
    const expected = proof;
    const start = epoch;
    if (!login && !publicRead && !expected) {
      if (transitioning) throw new ApiError(409, stale);
      return fail();
    }
    if (unsafe && !login && expected) {
      const check = await fetchResponse("/me", { headers: { Accept: "application/json", "X-Nexo-Context": expected.session_context }, signal: options.signal });
      ensureCurrent(start);
      if (!check.ok) return fail();
      const current = parseProof(await check.json().catch(() => null), check);
      ensureCurrent(start);
      if (!current || current.session_context !== expected.session_context || current.csrf_token !== expected.csrf_token) return fail();
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (expected && !login) headers["X-Nexo-Context"] = expected.session_context;
    if (unsafe && !login) headers["X-Nexo-CSRF"] = expected!.csrf_token;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetchResponse(path, { method, headers, signal: options.signal, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    if (start !== epoch) throw new ApiError(409, stale);
    const actual = res.headers.get("X-Nexo-Context");
    if (expected && !login && actual && actual !== expected.session_context) return fail();
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
      ensureCurrent(start);
      if (!login && (res.status === 401 || body?.code === "session_context_changed" || (unsafe && res.status === 403 && /CSRF/.test(body?.error ?? "")))) return fail();
      throw new ApiError(res.status, body?.error ?? `Não foi possível concluir a operação (${res.status}).`);
    }
    if (!login && !publicRead && !actual) return fail();
    if (login || path === "/auth/logout") { proof = null; epoch++; }
    return res;
  }
  return {
    beginSessionTransition() { proof = null; transitioning = true; epoch++; },
    session,
    async request<T>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
      const res = await response(path, options);
      const count = res.headers.get("X-Total-Count");
      const data = (res.status === 204 ? undefined : await res.json()) as T;
      return { data, total: count !== null && /^\d+$/.test(count) ? Number(count) : null };
    },
    async download(path: string) {
      const res = await response(path);
      const count = res.headers.get("X-Total-Count");
      return { blob: await res.blob(), total: count !== null && /^\d+$/.test(count) ? Number(count) : null };
    },
  };
}
