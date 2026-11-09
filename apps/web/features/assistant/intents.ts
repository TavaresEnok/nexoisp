// Assistente determinístico: reconhece intenções por regras, sem modelo de
// linguagem. Cada intenção corresponde a consultas já existentes na API e só é
// oferecida quando a sessão tem as permissões dessas consultas.
import { can, hasModule, type Session } from "@/features/session/model";

export type AssistantIntent =
  | { kind: "customer"; subject: string }
  | { kind: "diagnosis"; subject: string | null }
  | { kind: "overdue"; subject: string | null }
  | { kind: "orders"; today: boolean; subject: string | null }
  | {
      kind: "ip";
      ip: string;
      port: number | null;
      date: string | null;
      time: string | null;
    }
  | { kind: "unknown" };
export type IntentKind = Exclude<AssistantIntent["kind"], "unknown">;

/** Minúsculas sem acento, preservando o comprimento para mapear trechos ao texto original. */
export function fold(text: string) {
  return Array.from(text)
    .map((char) => {
      const folded = char
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      if (folded.length === char.length) return folded;
      const lower = char.toLowerCase();
      return lower.length === char.length ? lower : char;
    })
    .join("");
}

const leading =
  /^(?:(?:o|a|os|as|do|da|dos|das|de|pro|pra|para|ao|cliente|assinante|contrato|login|documento|cpf|cnpj|nome|sobre|chamad[oa])\s+)+/i;
function cleanSubject(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let value = raw.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  let previous = "";
  while (previous !== value) {
    previous = value;
    const match = fold(value).match(leading);
    if (match) value = value.slice(match[0].length).trim();
    value = value.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  }
  value = value.replace(/[\s,;:]+$/g, "");
  return Array.from(value).length >= 2 ? value : null;
}

/** Trecho do texto original correspondente ao grupo 1 de um padrão aplicado ao texto normalizado. */
function extract(original: string, m: RegExpMatchArray, atEnd = false) {
  const start =
    (m.index ?? 0) + (atEnd ? m[0].length - m[1].length : m[0].indexOf(m[1]));
  return cleanSubject(original.slice(start, start + m[1].length));
}

const ipv4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
const ipv6 =
  /(?:^|[\s(])((?:[0-9a-f]{1,4}:){1,7}:?(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?=$|[\s),])/i;
export function validIp(value: string) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value))
    return value.split(".").every((octet) => Number(octet) <= 255);
  if (!value.includes(":") || !/^[0-9a-f:]+$/i.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}
function findIp(text: string) {
  const v4 = text.match(ipv4);
  if (v4 && validIp(v4[1])) return { ip: v4[1], index: v4.index ?? 0 };
  const v6 = text.match(ipv6);
  if (v6 && validIp(v6[1])) return { ip: v6[1], index: text.indexOf(v6[1]) };
  return null;
}
const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function findDate(text: string, now: Date) {
  if (/\banteontem\b/.test(text))
    return isoDate(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2),
    );
  if (/\bontem\b/.test(text))
    return isoDate(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
    );
  if (/\bhoje\b/.test(text)) return isoDate(now);
  const m = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  if (year < 100) year += 2000;
  const date = new Date(year, month - 1, day);
  if (date.getDate() !== day || date.getMonth() !== month - 1) return null;
  return isoDate(date);
}
function findTime(text: string) {
  const m =
    text.match(/\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?(?:\s*min)?\b/) ??
    text.match(/\b(?:as|a|por volta das|perto das)\s+(\d{1,2})\b(?!\s*\/)/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

const trouble =
  /(sem internet|sem conexao|sem acesso|sem sinal|sem navegar|offline|fora do ar|nao (?:navega|conecta|funciona|tem internet)|internet (?:caiu|lenta|ruim|parou)|caiu a internet|esta lent[oa]|diagnostic[oa]r?|\b(?:internet|conexao)\b.*\b(?:caiu|parou|lenta|ruim)\b)/;
const overdueWords =
  /\b(faturas?|boletos?|cobrancas?|debitos?|mensalidades?|contas?)\b[^?]*?\b(vencid[oa]s?|em atraso|atrasad[oa]s?|em aberto|pendentes?|nao pag[oa]s?)\b|\b(inadimplen\w*|esta devendo|quanto\b.*\bdeve\b|devedor)/;
const ordersWords =
  /\bordens? de servico\b|\bo\.s\.?\b|^os d[oa] (?:cliente|assinante)\b|\bos (?:abertas?|pendentes?|de hoje|agendadas?|em aberto|do dia|para hoje|em andamento)\b|\b(?:abertas?|pendentes?) (?:as )?os\b/;
const customerLead =
  /^(?:(?:me )?(?:mostre|mostra|abra|abre|abrir|ver|veja|consultar?|buscar?|busque|procurar?|procure|pesquisar?|pesquise|localizar?|localize|encontrar?|encontre|achar?|ache|quem e)\s+(?:o |a )?(?:cliente|assinante|contrato|ficha)?|(?:cliente|assinante|ficha)\b)\s*(?:do |da |de )?/;

export function parseIntent(
  question: string,
  now = new Date(),
): AssistantIntent {
  const original = question
    .trim()
    .replace(/[?!.]+$/g, "")
    .trim();
  const text = fold(original);
  if (!text) return { kind: "unknown" };

  const ip = findIp(original);
  if (
    ip &&
    (/\bip\b|\bendereco\b|quem (?:estava|usava|usou|tinha)|\bporta\b/.test(
      text,
    ) ||
      original === ip.ip ||
      findTime(text.replace(ip.ip, " ")) !== null)
  ) {
    const rest = text.replace(fold(ip.ip), " ");
    const port = rest.match(/\bporta\s+(\d{1,5})\b/);
    const portNumber = port ? Number(port[1]) : null;
    return {
      kind: "ip",
      ip: ip.ip,
      port: portNumber && portNumber <= 65535 ? portNumber : null,
      date: findDate(rest, now),
      time: findTime(rest.replace(/\bporta\s+\d{1,5}\b/, " ")),
    };
  }

  if (ordersWords.test(text)) {
    const subject = text.match(
      /\b(?:do|da|de)\s+(?:cliente|assinante)\s+(.+)$/,
    );
    return {
      kind: "orders",
      today: /\bhoje\b|\bdo dia\b/.test(text),
      subject: subject ? extract(original, subject, true) : null,
    };
  }

  if (overdueWords.test(text)) {
    let subject: string | null = null;
    const after = text.match(
      /\b(?:vencid[oa]s?|em atraso|atrasad[oa]s?|em aberto|pendentes?|nao pag[oa]s?|inadimplen\w*|devedor)\s+(?:d[oa]s?|de)\s+(.+)$/,
    );
    const before = text.match(
      /^(?:o |a )?(?:cliente |assinante )?(.+?)\s+(?:tem|possui|esta com|ta com)\s+(?:faturas?|boletos?|debitos?|cobrancas?)/,
    );
    const owes = text.match(/\bquanto\s+(.+?)\s+(?:deve|esta devendo)\b/);
    const devendo = text.match(
      /^(?:o |a )?(?:cliente |assinante )?(.+?)\s+esta devendo\b/,
    );
    if (after) subject = extract(original, after, true);
    else {
      const pick = before ?? owes ?? devendo;
      if (pick) subject = extract(original, pick);
    }
    return { kind: "overdue", subject };
  }

  if (trouble.test(text)) {
    const patterns = [
      /\b(?:cliente|assinante)\s+(.+?)\s+(?:esta|ta|anda|continua|ficou|segue)?\s*(?:sem |offline|fora|nao |com a internet|com internet|reclamando)/,
      /\bdiagnostic[oa]r?\s+(?:d[oa]s?|de)?\s*(?:cliente |assinante |contrato )?(.+)$/,
      /^(?:por ?que|porque|o que houve com|o que aconteceu com|verifique|verificar)\s+(?:o |a )?(?:cliente |assinante )?(.+?)\s+(?:esta|ta|anda|continua|ficou)?\s*(?:sem |offline|fora|nao |com a internet)/,
      /^(?:o |a )?(?:cliente |assinante )?(.+?)\s+(?:esta|ta|anda|continua|ficou)\s+(?:sem |offline|fora)/,
      /\b(?:internet|conexao) d[oa]s?\s+(?:cliente |assinante )?(.+?)\s+(?:caiu|parou|esta|ta)\b/,
    ];
    let subject: string | null = null;
    for (const [index, pattern] of patterns.entries()) {
      const m = text.match(pattern);
      if (m) {
        subject = extract(original, m, index === 1);
        if (subject) break;
      }
    }
    return { kind: "diagnosis", subject };
  }

  const lead = text.match(customerLead);
  if (lead && lead[0].trim()) {
    const subject = cleanSubject(original.slice(lead[0].length));
    if (subject) return { kind: "customer", subject };
  }
  const digits = original.replace(/\D/g, "");
  if (
    /^[\d.\-/\s]+$/.test(original) &&
    (digits.length === 11 || digits.length === 14)
  )
    return { kind: "customer", subject: original };
  return { kind: "unknown" };
}

/** Consultas usadas por intenção; a interface oferece só o que a sessão pode ver. */
export function allowedIntents(me: Session | null): Set<IntentKind> {
  const out = new Set<IntentKind>();
  if (!me || !me.tenant || me.role === "subscriber" || me.mfa_pending)
    return out;
  const search = can(me, "subscribers:read");
  if (search) out.add("customer");
  if (search && can(me, "network:read") && hasModule(me, "noc"))
    out.add("diagnosis");
  if (can(me, "finance:read")) out.add("overdue");
  if (can(me, "os:read") && hasModule(me, "field")) out.add("orders");
  if (can(me, "legal:query") || search) out.add("ip");
  return out;
}

export const suggestions: { kind: IntentKind; question: string }[] = [
  { kind: "customer", question: "cliente Maria Souza" },
  { kind: "customer", question: "buscar 123.456.789-09" },
  {
    kind: "diagnosis",
    question: "por que o cliente Maria Souza está sem internet?",
  },
  { kind: "overdue", question: "faturas vencidas de Maria Souza" },
  { kind: "overdue", question: "faturas vencidas" },
  { kind: "orders", question: "OS abertas de hoje" },
  { kind: "ip", question: "IP 203.0.113.10 às 10h" },
];
export function suggestionsFor(me: Session | null) {
  const allowed = allowedIntents(me);
  return suggestions.filter((item) => allowed.has(item.kind));
}
export const intentLabels: Record<IntentKind, string> = {
  customer: "Busca de cliente",
  diagnosis: "Diagnóstico de acesso",
  overdue: "Faturas vencidas",
  orders: "Ordens de serviço",
  ip: "Consulta de IP",
};
