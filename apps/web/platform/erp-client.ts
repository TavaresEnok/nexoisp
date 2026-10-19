import { createApiClient } from "../data/erp/http";
export const sessionExpiredEvent = "nexo:session-expired";
export const erpClient = createApiClient((...args) => fetch(...args), () => window.dispatchEvent(new Event(sessionExpiredEvent)));
export async function api<T>(path: string, options?: Parameters<typeof erpClient.request>[1]): Promise<T> { return (await erpClient.request<T>(path, options)).data; }
export async function download(path: string, filename: string) {
  const blob = await erpClient.download(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
