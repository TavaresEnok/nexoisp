export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}
export type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };
export type HttpResponse<T> = { data: T; total: number | null };
export function createApiClient(fetcher: typeof fetch, onUnauthorized: () => void = () => {}) {
  async function response(path: string, options: RequestOptions = {}) {
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) throw new Error("Caminho de API inválido.");
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!["GET", "HEAD"].includes(method)) headers["X-Nexo-CSRF"] = "1";
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try { res = await fetcher(`/api${path}`, { method, headers, credentials: "same-origin", signal: options.signal, body: options.body === undefined ? undefined : JSON.stringify(options.body) }); }
    catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; throw new ApiError(0, "Não foi possível conectar ao servidor. Tente novamente."); }
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
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
      return { data: (res.status === 204 ? undefined : await res.json()) as T, total };
    },
    async download(path: string) { return (await response(path)).blob(); },
  };
}
