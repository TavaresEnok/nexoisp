import { createApiClient } from "../data/erp/http";
export const sessionExpiredEvent = "nexo:session-expired";
export const erpClient = createApiClient((...args) => fetch(...args), () => window.dispatchEvent(new Event(sessionExpiredEvent)));
export async function api<T>(path: string, options?: Parameters<typeof erpClient.request>[1]): Promise<T> { return (await erpClient.request<T>(path, options)).data; }
export type DownloadResult = { total: number | null; limit: number | null; truncated: boolean };
// Indica quando o servidor cortou a exportação no limite pedido (X-Total-Count maior que limit).
export function exportCoverage(path: string, total: number | null): DownloadResult {
  const raw = new URL(path, "http://nexo.invalid").searchParams.get("limit");
  const limit = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  return { total, limit, truncated: total !== null && limit !== null && total > limit };
}
export async function download(path: string, filename: string): Promise<DownloadResult> {
  const { blob, total } = await erpClient.download(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return exportCoverage(path, total);
}
