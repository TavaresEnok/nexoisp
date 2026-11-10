import { z } from "zod";

/** Configuração da consulta pública de viabilidade, lida e gravada pelo Go. */
export const viabilitySettingsSchema = z.object({
  enabled: z.boolean(),
  radius_m: z.coerce.number().int(),
  message: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  create_lead: z.boolean(),
  updated_at: z.string().nullable(),
  slug: z.string(),
  public_path: z.string(),
  modules: z.object({ ftth: z.boolean(), crm: z.boolean() }),
});
export type ViabilitySettings = z.infer<typeof viabilitySettingsSchema>;

/** Página pública: só marca e contato; nada sobre caixas ou ocupação. */
export const publicViabilitySchema = z.object({
  name: z.string(),
  logo: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
  message: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  lead_capture: z.boolean(),
});
export type PublicViability = z.infer<typeof publicViabilitySchema>;

export const viabilityResultSchema = z.object({
  covered: z.boolean(),
  lead_capture: z.boolean(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
});
export type ViabilityResult = z.infer<typeof viabilityResultSchema>;

export const viabilityRadius = { min: 50, max: 2000, default: 250 } as const;

/** Aceita vírgula decimal e confere a faixa; devolve null quando inválido. */
export function parseCoordinate(raw: string, kind: "latitude" | "longitude") {
  const text = raw.trim().replace(",", ".");
  if (!/^-?\d{1,3}(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  const limit = kind === "latitude" ? 90 : 180;
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/** Link do WhatsApp apenas com dígitos (DDI, DDD e número). */
export function whatsappLink(digits: string | null) {
  const clean = (digits ?? "").replace(/\D/g, "");
  return clean.length >= 10 && clean.length <= 15
    ? `https://wa.me/${clean}`
    : null;
}

export const publicViabilityPath = (slug: string) =>
  `/public/viabilidade/${encodeURIComponent(slug)}`;
