import { serializeCsv } from "../domain/csv";

export function downloadContent(name: string, content: string, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
export function exportCsv(name: string, headers: string[], rows: (string | number)[][]) {
  downloadContent(`${name}.csv`, serializeCsv(headers, rows), "text/csv;charset=utf-8;");
}
export function copyText(value: string, clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard): Promise<void> {
  if (!clipboard) return Promise.reject(new Error("Área de transferência indisponível."));
  return clipboard.writeText(value);
}
export function printDocument(target: Pick<Window, "focus" | "print"> | null | undefined) {
  if (!target) throw new Error("Ficha indisponível para impressão.");
  target.focus();
  target.print();
}
