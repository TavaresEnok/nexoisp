export function serializeCsv(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const clean = (value: string | number) => {
    const text = String(value);
    const safe = /^\s*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [headers, ...rows].map(row => row.map(clean).join(";")).join("\r\n");
}
