import type { Subscriber } from "./workspace";
import { normalize } from "./formatters";

export type AccessDetails = {
  latitude?: number; longitude?: number; login?: string; ip?: string; mac?: string;
  olt?: string; oltSlot?: string; pon?: string; complement?: string; connectionType?: string;
  group?: string; ipv6?: boolean; ipv6Pd?: boolean; fixedIp?: boolean; personType?: string;
  simultaneousSessions?: number; serviceName?: string; nasPortId?: string; tags?: string[];
  uptime?: string; download?: string; upload?: string;
};
export type NetworkSubscriber = Subscriber;
export const querySections = [
  { id: "infra", label: "Infraestrutura", description: "Delimite a consulta por POP, concentrador e caminho óptico.", fields: [
    ["pop", "POP", "select"], ["nas", "NAS / concentrador", "select"], ["olt", "OLT", "select"], ["oltSlot", "OLT Slot", "text"], ["pon", "Porta PON", "select"],
  ] },
  { id: "connection", label: "Conexão", description: "Identifique a sessão e os parâmetros de acesso do assinante.", fields: [
    ["login", "Login", "text"], ["ip", "IP ou rede IPv4", "text"], ["mac", "Endereço MAC", "text"], ["connectionType", "Tipo de conexão", "select"], ["ipv6", "Com IPv6?", "boolean"], ["ipv6Pd", "Com IPv6 PD?", "boolean"], ["onu", "Com ONU?", "boolean"], ["simultaneousSessions", "Sessões simultâneas", "select"], ["serviceName", "Service Name", "text"], ["nasPortId", "NAS PortId", "text"], ["fixedIp", "Somente IP fixo", "check"],
  ] },
  { id: "address", label: "Endereço", description: "Consulte o endereço de instalação registrado pelo técnico.", fields: [
    ["address", "Logradouro", "text"], ["neighborhood", "Bairro", "text"], ["complement", "Complemento", "text"],
  ] },
  { id: "subscriber", label: "Assinante", description: "Combine os dados de contrato e a classificação dos clientes.", fields: [
    ["plan", "Plano", "select"], ["status", "Status do contrato", "select"], ["group", "Grupo", "select"], ["personType", "Tipo de pessoa", "select"],
  ] },
  { id: "regulatory", label: "ANATEL & tags", description: "Refine a seleção por tags e consulte a disponibilidade dos dados regulatórios.", fields: [["tags", "Tags do assinante", "select"]] },
] as const;
export type QueryKey = typeof querySections[number]["fields"][number][0];
export type NetworkFilters = Partial<Record<QueryKey, string>> & { visibility?: string };
export const filterLabels = Object.fromEntries(querySections.flatMap(s => s.fields.map(([key, label]) => [key, label]))) as Record<QueryKey, string>;
export function accessValue(s: NetworkSubscriber, key: QueryKey): unknown {
  if (key === "onu") return s.onu ? true : undefined;
  if (["pop", "nas", "address", "neighborhood", "plan", "status"].includes(key)) return s[key as keyof Subscriber];
  return s.access?.[key as keyof AccessDetails];
}
export function hasLocation(s: NetworkSubscriber): s is NetworkSubscriber & { access: AccessDetails & { latitude: number; longitude: number } } {
  const a = s.access;
  return typeof a?.latitude === "number" && Number.isFinite(a.latitude) && Math.abs(a.latitude) <= 90 && typeof a.longitude === "number" && Number.isFinite(a.longitude) && Math.abs(a.longitude) <= 180;
}
const ipNumber = (ip: string) => {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return null;
  const parts = ip.split(".").map(Number);
  return parts.some(n => n > 255) ? null : parts.reduce((v, n) => (v * 256 + n) >>> 0, 0);
};
export function validIpQuery(value: string) {
  const [ip, prefix, extra] = value.split("/");
  return ipNumber(ip) !== null && extra === undefined && (prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32));
}
function ipMatches(ip: string, network: string) {
  const [base, prefix] = network.split("/");
  const value = ipNumber(ip), target = ipNumber(base);
  if (value === null || target === null || !validIpQuery(network)) return false;
  const mask = prefix === undefined ? 0xffffffff : Number(prefix) === 0 ? 0 : (0xffffffff << (32 - Number(prefix))) >>> 0;
  return ((value & mask) >>> 0) === ((target & mask) >>> 0);
}
export function matchesNetwork(s: NetworkSubscriber, filters: NetworkFilters, search = "") {
  const online = s.connection === "Online";
  if (filters.visibility === "online" && !online || filters.visibility === "offline" && online) return false;
  if (search && !normalize([s.name, s.code, s.address, s.neighborhood, s.access?.login, s.access?.ip, s.access?.mac].join(" ")).includes(normalize(search))) return false;
  return Object.entries(filters).every(([key, value]) => {
    if (!value || key === "visibility") return true;
    const current = accessValue(s, key as QueryKey);
    if (current === undefined || current === null || current === "") return false;
    if (["fixedIp", "ipv6", "ipv6Pd", "onu"].includes(key)) return current === (value === "yes");
    if (key === "ip") return ipMatches(String(current), value);
    if (Array.isArray(current)) return current.includes(value);
    if (["address", "neighborhood", "complement", "login", "serviceName", "nasPortId"].includes(key)) return normalize(String(current)).includes(normalize(value));
    if (key === "mac") return String(current).replace(/[:-]/g, "").toLowerCase().includes(value.replace(/[:-]/g, "").toLowerCase());
    return String(current) === value;
  });
}
export function networkOptions(rows: NetworkSubscriber[], key: QueryKey, filters: NetworkFilters): string[] {
  const scoped = key === "nas" ? rows.filter(s => !filters.pop || s.pop === filters.pop) : key === "pon" ? rows.filter(s => !filters.olt || s.access?.olt === filters.olt) : rows;
  return [...new Set(scoped.flatMap(s => { const v = accessValue(s, key); return v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [String(v)]; }))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}
