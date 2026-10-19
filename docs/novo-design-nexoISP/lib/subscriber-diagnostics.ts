import { z } from "zod";
import { buildOnuReadOnlyScript } from "./subscriber-profile";

export const MAX_EVIDENCE_LENGTH = 100_000;

export type OnuEvidence = {
  serial: string;
  fields: Record<string, string>;
  rx?: number;
  tx?: number;
  oltRx?: number;
  temperature?: number;
  voltage?: number;
  laser?: number;
  distance?: number;
  raw: string;
};

function serialIdentity(serial: string) {
  const value = serial.trim().toUpperCase();
  if (/^[A-Z]{4}[A-F0-9]{8}$/.test(value)) {
    return [...value.slice(0, 4)].map(char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase() + value.slice(4);
  }
  return value;
}

export function parseHuaweiEvidence(raw: string, expectedSerial: string): OnuEvidence {
  if (!raw.trim() || raw.length > MAX_EVIDENCE_LENGTH) throw new Error("Cole uma saída de até 100.000 caracteres.");
  buildOnuReadOnlyScript(expectedSerial);
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 /()_.-]*?)\s*:\s*(.*?)\s*$/);
    if (!match || !match[2] || /^[-–]+$/.test(match[2])) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, " ");
    const value = match[2].trim();
    if (fields[key] && fields[key] !== value) throw new Error(`Há valores diferentes para “${match[1].trim()}”. Cole uma única coleta de uma única ONU.`);
    fields[key] = value;
  }
  const serial = fields.sn?.match(/^[A-Za-z0-9]+/)?.[0];
  if (!serial) throw new Error("Não foi encontrado o campo SN. Inclua a saída de display ont info para conferir a identidade da ONU.");
  if (serialIdentity(serial) !== serialIdentity(expectedSerial)) throw new Error("O serial da saída não corresponde à ONU deste assinante. Nenhum dado foi aplicado.");
  const numeric = (key: string) => {
    const value = fields[key];
    if (!value || !/^-?\d+(?:[.,]\d+)?(?:\s*(?:dBm|°?C|V|mA|m))?$/i.test(value)) return undefined;
    const number = Number.parseFloat(value.replace(",", "."));
    return Number.isFinite(number) ? number : undefined;
  };
  return {
    serial, fields, raw,
    rx: numeric("rx optical power(dbm)"), tx: numeric("tx optical power(dbm)"),
    oltRx: numeric("olt rx ont optical power(dbm)"),
    temperature: numeric("temperature(c)"), voltage: numeric("voltage(v)"),
    laser: numeric("laser bias current(ma)"), distance: numeric("ont distance(m)"),
  };
}

export function buildHuaweiDiagnosticScript(serial: string, location: { frame: string; slot: string; pon: string; ontId: string }) {
  const initial = buildOnuReadOnlyScript(serial);
  for (const [name, value] of Object.entries(location)) {
    if (!/^\d{1,3}$/.test(value) || Number(value) > (name === "ontId" ? 255 : 31)) {
      throw new Error("Informe frame, slot e PON entre 0 e 31 e ONT-ID entre 0 e 255. Apenas números são aceitos.");
    }
  }
  const { frame, slot, pon, ontId } = Object.fromEntries(Object.entries(location).map(([key, value]) => [key, String(Number(value))]));
  return `${initial}interface gpon ${frame}/${slot}\ndisplay ont info ${pon} ${ontId}\ndisplay ont optical-info ${pon} ${ontId}\ndisplay ont version ${pon} ${ontId}\nquit\n`;
}

const radiusRecordSchema = z.object({
  username: z.string().trim().min(1).max(128),
  acctsessionid: z.string().trim().min(1).max(128),
  acctstarttime: z.iso.datetime({ offset: true }),
  acctstoptime: z.iso.datetime({ offset: true }).nullable(),
  acctsessiontime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nasipaddress: z.ipv4(),
  framedipaddress: z.ipv4().optional(),
  callingstationid: z.string().regex(/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i).optional(),
  acctterminatecause: z.string().max(128).optional(),
  acctinputoctets: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  acctoutputoctets: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  delegatedipv6prefix: z.string().max(64).optional(),
  nasportid: z.string().max(128).optional(),
}).refine(row => !row.acctstoptime || Date.parse(row.acctstoptime) >= Date.parse(row.acctstarttime), "Encerramento anterior ao início da sessão.");
export type RadiusRecord = z.infer<typeof radiusRecordSchema>;

export function parseRadiusEvidence(raw: string, login: string): RadiusRecord[] {
  if (!login.trim()) throw new Error("Informe o login esperado para conferir a identidade das sessões.");
  if (!raw.trim() || raw.length > MAX_EVIDENCE_LENGTH) throw new Error("Informe um JSON de até 100.000 caracteres.");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error("O conteúdo não é um JSON válido."); }
  const parsed = z.array(radiusRecordSchema).min(1).max(200).safeParse(input);
  if (!parsed.success) throw new Error("Formato inválido. Confira os campos obrigatórios, IPs, MAC, datas ISO com fuso horário e contadores numéricos. Limite: 200 sessões.");
  if (parsed.data.some(row => row.username !== login.trim())) throw new Error("Há sessões de outro login no arquivo. Nenhum registro foi aplicado.");
  if (new Set(parsed.data.map(row => row.acctsessionid)).size !== parsed.data.length) throw new Error("Existem identificadores de sessão duplicados.");
  return parsed.data.sort((a, b) => Date.parse(b.acctstarttime) - Date.parse(a.acctstarttime));
}

export function durationLabel(seconds?: number) {
  if (seconds === undefined) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}min`;
}
export function byteLabel(value?: number) {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** index).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`;
}
