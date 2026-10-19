import { z } from "zod";

const text = z.string().trim().min(1).max(500);
const count = z.number().int().nonnegative();
const status = z.enum(["Online", "Offline"]);
const model = z.object({ id: text, code: text, vendor: text, description: text, ports: text, wifi: text, mode: z.enum(["Bridge", "Router"]), profile: text, compatibleOlts: z.array(text), notes: text });
const template = z.object({ id: text, name: text, vendor: text, mode: z.enum(["Bridge", "Router"]), modelIds: z.array(text), compatibleOlts: z.array(text), gpon: z.string().max(20000), wan: z.string().max(20000), notes: text });
const pool = z.object({ id: text, name: text, ranges: text, fixed: count, lease: count, online: count, free: count, nasId: text, nextPoolId: z.string(), radiusAttribute: text, notes: text });
const nas = z.object({ id: text, name: text, host: text, vendor: text, driver: text, authPort: count.min(1).max(65535), acctPort: count.min(1).max(65535), snmpPort: count.min(1).max(65535), timeout: count.min(1), popId: text, status, active: z.boolean(), sessions: count, suspended: count, notes: text });
const cgnat = z.object({ id: text, name: text, interface: text, publicRange: text, privateRange: text, firstPort: count.min(1).max(65535), lastPort: count.min(1).max(65535), portsPerIp: count.min(1), protocol: z.enum(["TCP/UDP", "TCP", "UDP"]), icmp: z.boolean(), nasId: text, strategy: text, active: z.boolean() });
const vpn = z.object({ id: text, username: text, ip: text, routes: z.array(text), nasId: text, type: text, status, uptime: text.nullable(), inUse: z.boolean() });
const pop = z.object({ id: text, name: text, city: text, uf: z.string().length(2), active: z.boolean(), population: count.nullable(), contracts: z.object({ active: count, inactive: count, suspended: count, cancelled: count }), users: z.array(text) });
export const technicalCatalogSchema = z.object({ version: z.literal(1), asOf: z.iso.datetime(), models: z.array(model), templates: z.array(template), pools: z.array(pool), nas: z.array(nas), cgnat: z.array(cgnat), vpns: z.array(vpn), pops: z.array(pop) }).superRefine((catalog, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  for (const key of ["models", "templates", "pools", "nas", "cgnat", "vpns", "pops"] as const) {
    if (new Set(catalog[key].map(item => item.id)).size !== catalog[key].length) invalid(`IDs duplicados em ${key}.`);
  }
  for (const item of catalog.templates) if (item.modelIds.some(id => !catalog.models.some(m => m.id === id))) invalid("Modelo de template inexistente.");
  for (const item of [...catalog.pools, ...catalog.cgnat, ...catalog.vpns]) if (!catalog.nas.some(n => n.id === item.nasId)) invalid("Vínculo NAS inexistente.");
  for (const item of catalog.nas) if (!catalog.pops.some(p => p.id === item.popId)) invalid("Vínculo POP inexistente.");
  for (const item of catalog.pools) {
    try {
      if (rangeSize(item.ranges) !== item.fixed + item.lease + item.online + item.free) invalid(`Ocupação inconsistente: ${item.name}.`);
    } catch { invalid(`Faixa inválida: ${item.name}.`); }
    if (item.nextPoolId && (!catalog.pools.some(p => p.id === item.nextPoolId) || item.nextPoolId === item.id)) invalid("Failover inválido.");
  }
  for (const item of catalog.cgnat) { try { cgnatCapacity(item); } catch { invalid(`Plano CGNAT inválido: ${item.name}.`); } }
});
export type TechnicalCatalog = z.infer<typeof technicalCatalogSchema>;
export type OnuModel = TechnicalCatalog["models"][number];
export type OnuTemplate = TechnicalCatalog["templates"][number];
export type IpPool = TechnicalCatalog["pools"][number];
export type CgnatPlan = TechnicalCatalog["cgnat"][number];
export type CoreTab = "pools" | "nas" | "cgnat" | "vpn" | "pops";

function ipv4(value: string): number {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) throw new Error("Endereço IPv4 inválido.");
  const octets = value.split(".").map(Number);
  if (octets.some(octet => octet > 255)) throw new Error("Endereço IPv4 inválido.");
  return octets.reduce((sum, octet) => sum * 256 + octet, 0);
}
export function rangeSize(value: string): number {
  const ranges = value.trim().split(/[\n,]+/).map(line => {
    const range = line.trim();
    if (range.includes("/")) {
      const parts = range.split("/");
      if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[1]) || Number(parts[1]) > 32) throw new Error("Prefixo IPv4 inválido.");
      const size = 2 ** (32 - Number(parts[1]));
      const start = Math.floor(ipv4(parts[0]) / size) * size;
      return { start, end: start + size - 1 };
    }
    const parts = range.split("-").map(part => part.trim());
    if (parts.length > 2 || parts.some(part => !part)) throw new Error("Intervalo inválido.");
    const start = ipv4(parts[0]);
    const end = parts[1] ? ipv4(parts[1]) : start;
    if (end < start) throw new Error("Intervalo invertido.");
    return { start, end };
  }).sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index > 0 && range.start <= ranges[index - 1].end)) throw new Error("Existem faixas sobrepostas.");
  return ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
}
export function cgnatCapacity(plan: Pick<CgnatPlan, "firstPort" | "lastPort" | "portsPerIp" | "publicRange" | "privateRange">) {
  const { firstPort, lastPort, portsPerIp } = plan;
  if (![firstPort, lastPort, portsPerIp].every(Number.isInteger) || firstPort < 1 || lastPort > 65535 || firstPort > lastPort || portsPerIp < 1 || portsPerIp > lastPort - firstPort + 1) throw new Error("Configuração de portas inválida.");
  const publicIps = rangeSize(plan.publicRange);
  const privateIps = rangeSize(plan.privateRange);
  const blocksPerIp = Math.floor((lastPort - firstPort + 1) / portsPerIp);
  return { publicIps, privateIps, blocksPerIp, capacity: publicIps * blocksPerIp, remainder: (lastPort - firstPort + 1) % portsPerIp, deficit: Math.max(0, privateIps - publicIps * blocksPerIp) };
}

export const cliVariables = ["vlan", "slot", "pon", "sn", "login"] as const;
export type CliVariables = Record<typeof cliVariables[number], string>;
export function compileProvisioning(source: string, variables: CliVariables): { output: string; errors: string[]; used: string[] } {
  const errors: string[] = [];
  const used = [...new Set([...source.matchAll(/%([^%\r\n]+)%/g)].map(match => match[1]))];
  if (!source.trim()) errors.push("Informe um template para processar.");
  if (source.length > 20000) errors.push("O template deve ter no máximo 20.000 caracteres.");
  for (const key of used) {
    if (!cliVariables.includes(key as typeof cliVariables[number])) { errors.push(`Variável não reconhecida: %${key}%.`); continue; }
    const value = variables[key as keyof CliVariables].trim();
    if (!value) { errors.push(`Preencha a variável %${key}%.`); continue; }
    if (key === "vlan" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 4094)) errors.push("VLAN deve ser um número inteiro entre 1 e 4094.");
    if ((key === "slot" || key === "pon") && (!/^\d+$/.test(value) || Number(value) > (key === "slot" ? 31 : 255))) errors.push(`${key === "slot" ? "Slot" : "PON"} fora do intervalo permitido.`);
    if (key === "sn" && !/^(?:[A-Z]{4}[A-F0-9]{8}|[A-F0-9]{16})$/i.test(value)) errors.push("Serial deve conter 4 letras e 8 hexadecimais, ou 16 hexadecimais.");
    if (key === "login" && !/^[a-zA-Z0-9_.@-]{1,64}$/.test(value)) errors.push("Login aceita apenas letras, números, ponto, hífen, sublinhado e @, até 64 caracteres.");
  }
  return { errors, used, output: errors.length ? "" : source.replace(/%([^%\r\n]+)%/g, (_, key: keyof CliVariables) => variables[key].trim()) };
}
