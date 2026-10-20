export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}
export type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };
export type HttpResponse<T> = { data: T; total: number | null };
const csrfRejected = /CSRF/;
export function createApiClient(fetcher: typeof fetch, onUnauthorized: () => void = () => {}) {
  // Valor CSRF derivado da sessão; chega por /me e pela resposta do login, nunca do cookie HttpOnly.
  let csrf: string | null = null;
  function remember(path: string, data: unknown) {
    if (path === "/auth/logout") csrf = null;
    const token = (data as { csrf_token?: unknown } | null)?.csrf_token;
    if ((path === "/me" || path === "/auth/login") && typeof token === "string") csrf = token;
  }
  async function csrfToken(signal?: AbortSignal) {
    if (csrf) return csrf;
    const res = await fetcher("/api/me", { headers: { Accept: "application/json" }, credentials: "same-origin", signal }).catch(() => null);
    if (res?.ok) remember("/me", await res.json().catch(() => null));
    return csrf;
  }
  async function response(path: string, options: RequestOptions = {}, retried = false): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) throw new Error("Caminho de API inválido.");
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { Accept: "application/json" };
    const unsafe = !["GET", "HEAD"].includes(method);
    if (unsafe && path !== "/auth/login") headers["X-Nexo-CSRF"] = (await csrfToken(options.signal)) ?? "";
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try { res = await fetcher(`/api${path}`, { method, headers, credentials: "same-origin", signal: options.signal, body: options.body === undefined ? undefined : JSON.stringify(options.body) }); }
    catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; throw new ApiError(0, "Não foi possível conectar ao servidor. Tente novamente."); }
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      // Sessão trocada em outra aba: busca o valor da sessão atual e tenta uma vez.
      if (res.status === 403 && unsafe && !retried && csrfRejected.test(body?.error ?? "")) { csrf = null; return response(path, options, true); }
      if (res.status === 401 && path !== "/auth/login" && path !== "/me") onUnauthorized();
      throw new ApiError(res.status, body?.error ?? `Não foi possível concluir a operação (${res.status}).`);
    }
    return res;
  }
  return {
    async request<T>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
      const res = await response(path, options);
      const count = res.headers.get("X-Total-Count");
      const total = count !== null && /^\d+$/.test(count) ? Number(count) : null;
      const data = (res.status === 204 ? undefined : await res.json()) as T;
      remember(path, data);
      return { data, total };
    },
    async download(path: string) {
      const res = await response(path);
      const count = res.headers.get("X-Total-Count");
      return { blob: await res.blob(), total: count !== null && /^\d+$/.test(count) ? Number(count) : null };
    },
  };
}
