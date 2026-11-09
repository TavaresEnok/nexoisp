import { z } from "zod";

const nullableNumber = z.number().nullable();
export const visitSchema = z.object({
  id: z.string().uuid(),
  technician_id: z.string().uuid(),
  technician_name: z.string(),
  check_in_at: z.string(),
  check_in_device_at: z.string().nullable(),
  check_in_accuracy_m: nullableNumber,
  check_in_distance_m: nullableNumber,
  check_in_located: z.boolean(),
  check_out_at: z.string().nullable(),
  check_out_reason: z.enum(["technician", "os_finished"]).nullable(),
  check_out_device_at: z.string().nullable(),
  check_out_accuracy_m: nullableNumber,
  check_out_distance_m: nullableNumber,
  check_out_located: z.boolean(),
  seconds: z.number().min(0),
});
export const visitsSchema = z.object({
  items: z.array(visitSchema),
  open_visit_id: z.string().uuid().nullable(),
  attendance_seconds: z.number().min(0),
  site_located: z.boolean(),
  server_time: z.string(),
  can_check_in: z.boolean(),
  can_check_out: z.boolean(),
});
export const signatureSchema = z.object({
  id: z.string().uuid(),
  document_id: z.string().uuid(),
  signer_name: z.string().min(1).max(120),
  signer_document: z.string().nullable(),
  signed_at: z.string(),
  device_at: z.string().nullable(),
  signed_by_name: z.string().nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes: z.number().int().min(1),
  mime: z.literal("image/png"),
});
export const signatureStateSchema = z.object({
  signature: signatureSchema.nullable(),
  can_sign: z.boolean(),
});
export type Visit = z.infer<typeof visitSchema>;
export type Visits = z.infer<typeof visitsSchema>;
export type Signature = z.infer<typeof signatureSchema>;

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "menos de 1 min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return `${hours} h ${String(rest).padStart(2, "0")} min`;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

/** Texto da posição registrada: distância até a instalação quando o contrato tem coordenada. */
export function describeLocation(
  located: boolean,
  distance: number | null,
  accuracy: number | null,
  siteLocated: boolean,
): string {
  if (!located) return "Localização não enviada";
  const precision =
    accuracy !== null ? ` (precisão de ${formatDistance(accuracy)})` : "";
  if (distance !== null)
    return `A ${formatDistance(distance)} da instalação${precision}`;
  return siteLocated
    ? `Localização registrada${precision}`
    : `Localização registrada; instalação sem coordenada${precision}`;
}

/** Aceita apenas PNG em base64 para a imagem embutida na ficha impressa. */
export function safePngDataUrl(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value
    : undefined;
}
