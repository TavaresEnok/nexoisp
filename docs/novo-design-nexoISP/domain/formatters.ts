export const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
export const number = (value: number) => new Intl.NumberFormat("pt-BR").format(value);
export const date = (value: string) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Sao_Paulo" }).format(new Date(value.length === 10 ? `${value}T12:00:00-03:00` : value));
export const clock = (value: string) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date(value));
export const percent = (value: number, digits = 1) => `${value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
export const initials = (name: string) => name.split(" ").filter(Boolean).map(w => w[0]).slice(0, 2).join("");
export const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function scenarioDate(asOf: string, style: "day" | "weekday" | "month" | "full" = "day") {
  const options: Intl.DateTimeFormatOptions = style === "month" ? { month: "long", year: "numeric" } : { day: "numeric", month: "long", ...(style === "weekday" ? { weekday: "long" } : {}), ...(style === "full" ? { year: "numeric" } : {}) };
  return new Intl.DateTimeFormat("pt-BR", { ...options, timeZone: "America/Sao_Paulo" }).format(new Date(asOf));
}
