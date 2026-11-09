import { z } from "zod";

// Projeto físico FTTH: cabos com traçado, fusões, OTDR e importação KML. O
// servidor Go valida, calcula o comprimento e isola por provedor e POP.

export const cableKinds = [
  { value: "aerial", label: "Aéreo" },
  { value: "underground", label: "Subterrâneo" },
  { value: "drop", label: "Drop" },
] as const;
export const cableKindLabel = (kind: string) =>
  cableKinds.find((item) => item.value === kind)?.label ?? kind;

export const otdrEventTypes = [
  { value: "splice", label: "Fusão" },
  { value: "connector", label: "Conector" },
  { value: "bend", label: "Curvatura" },
  { value: "reflection", label: "Reflexão" },
  { value: "break", label: "Rompimento" },
  { value: "end", label: "Fim da fibra" },
  { value: "other", label: "Outro" },
] as const;
export const otdrEventLabel = (type: string) =>
  otdrEventTypes.find((item) => item.value === type)?.label ?? type;
export const wavelengths = ["1310", "1550", "1625"] as const;

const point = z.object({ lat: z.number().finite(), lng: z.number().finite() });
export type CablePoint = z.infer<typeof point>;
export const cableSchema = z.object({
  id: z.string().uuid(),
  pop_id: z.string().uuid(),
  pop_name: z.string(),
  name: z.string(),
  kind: z.enum(["aerial", "underground", "drop"]),
  fiber_count: z.number().int(),
  a_box_id: z.string().nullable(),
  a_box_name: z.string().nullable(),
  a_site_id: z.string().nullable(),
  a_site_name: z.string().nullable(),
  b_box_id: z.string().nullable(),
  b_box_name: z.string().nullable(),
  b_site_id: z.string().nullable(),
  b_site_name: z.string().nullable(),
  computed_length_m: z.number(),
  declared_length_m: z.number().nullable(),
  notes: z.string(),
  active: z.boolean(),
});
export type Cable = z.infer<typeof cableSchema>;
export const cablePageSchema = z.object({
  items: z.array(cableSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export const cableDetailSchema = cableSchema.extend({
  path: z.array(point),
  fusion_count: z.number().int(),
  otdr_count: z.number().int(),
});
export type CableDetail = z.infer<typeof cableDetailSchema>;
export const cableMapSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      kind: z.string(),
      fiber_count: z.number().int(),
      pop_name: z.string(),
      computed_length_m: z.number(),
      path: z.array(point),
    }),
  ),
  truncated: z.boolean(),
});
export type MapCable = z.infer<typeof cableMapSchema>["items"][number];

export const fusionSchema = z.object({
  id: z.string().uuid(),
  a_cable_id: z.string().uuid(),
  a_cable_name: z.string(),
  a_fiber: z.number().int(),
  b_cable_id: z.string().nullable(),
  b_cable_name: z.string().nullable(),
  b_fiber: z.number().int().nullable(),
  b_port: z.number().int().nullable(),
  loss_db: z.number().nullable(),
  notes: z.string(),
});
export type Fusion = z.infer<typeof fusionSchema>;
export const fusionListSchema = z.object({
  box: z.object({ id: z.string().uuid(), name: z.string(), ports: z.number() }),
  items: z.array(fusionSchema),
});

export const otdrSchema = z.object({
  id: z.string().uuid(),
  fiber: z.number().int(),
  measured_on: z.string(),
  wavelength_nm: z.number().int(),
  total_distance_m: z.number(),
  total_loss_db: z.number(),
  events: z.array(
    z.object({ distance_m: z.number(), loss_db: z.number(), type: z.string() }),
  ),
  technician: z.string(),
  notes: z.string(),
  file_name: z.string().nullable(),
  file_size: z.number().nullable(),
});
export type OtdrMeasurement = z.infer<typeof otdrSchema>;
export const otdrListSchema = z.object({ items: z.array(otdrSchema) });

const issues = z.array(z.string());
export const kmlPreviewSchema = z.object({
  boxes: z.array(
    z.object({
      index: z.number(),
      name: z.string(),
      kind: z.string(),
      ports: z.number(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      errors: issues,
    }),
  ),
  cables: z.array(
    z.object({
      index: z.number(),
      name: z.string(),
      kind: z.string(),
      fiber_count: z.number(),
      points: z.number(),
      computed_length_m: z.number(),
      a_box_name: z.string().nullable(),
      b_box_name: z.string().nullable(),
      errors: issues,
    }),
  ),
  ignored: z.array(
    z.object({ index: z.number(), name: z.string(), reason: z.string() }),
  ),
  valid: z.boolean(),
  sha256: z.string(),
});
export type KmlPreview = z.infer<typeof kmlPreviewSchema>;
export const kmlApplySchema = z.object({
  boxes_created: z.number(),
  cables_created: z.number(),
  ignored: z.number(),
});

export const maxUploadBytes = 5 * 1024 * 1024;

// Uma coordenada por linha: "latitude, longitude" (vírgula ou ponto e vírgula).
export function parsePathText(text: string): CablePoint[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || lines.length > 500)
    throw new Error("Informe de 2 a 500 coordenadas, uma por linha.");
  return lines.map((line, index) => {
    const parts = line.split(/\s*[;,\s]\s*/).filter(Boolean);
    const [lat, lng] = parts.map(Number);
    if (
      parts.length !== 2 ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    )
      throw new Error(
        `Coordenada inválida na linha ${index + 1}: use "latitude, longitude".`,
      );
    return { lat, lng };
  });
}
export const formatPathText = (path: CablePoint[]) =>
  path.map((p) => `${p.lat}, ${p.lng}`).join("\n");

// Mesmo cálculo do servidor, só para exibir a estimativa antes de salvar.
export function pathLength(path: CablePoint[]): number {
  const radius = 6371008.8;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    const la1 = (a.lat * Math.PI) / 180,
      la2 = (b.lat * Math.PI) / 180;
    const dla = la2 - la1,
      dlo = ((b.lng - a.lng) * Math.PI) / 180;
    const h =
      Math.sin(dla / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
    total += 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return Math.round(total * 100) / 100;
}
export const formatMeters = (meters: number) =>
  meters >= 1000
    ? `${(meters / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} km`
    : `${meters.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} m`;

// Extremidade codificada no seletor: "box:<id>", "site:<id>" ou vazio.
export function endpointValue(box: string | null, site: string | null) {
  return box ? `box:${box}` : site ? `site:${site}` : "";
}
export function endpointFields(side: "a" | "b", value: string) {
  const [kind, id] = value.split(":");
  return {
    [`${side}_box_id`]: kind === "box" ? id : null,
    [`${side}_site_id`]: kind === "site" ? id : null,
  } as Record<string, string | null>;
}

// Eventos OTDR: "distância_m; perda_dB; tipo" por linha.
export function parseEventsText(
  text: string,
): { distance_m: number; loss_db: number; type: string }[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 200) throw new Error("Informe até 200 eventos.");
  return lines.map((line, index) => {
    const [distance, loss, type] = line.split(";").map((part) => part.trim());
    const known = otdrEventTypes.find(
      (item) =>
        item.value === type?.toLowerCase() ||
        item.label.toLowerCase() === type?.toLowerCase(),
    );
    const distance_m = Number(distance?.replace(",", "."));
    const loss_db = Number(loss?.replace(",", "."));
    if (
      !known ||
      !Number.isFinite(distance_m) ||
      distance_m < 0 ||
      !Number.isFinite(loss_db)
    )
      throw new Error(
        `Evento inválido na linha ${index + 1}: use "distância; perda; tipo".`,
      );
    return { distance_m, loss_db, type: known.value };
  });
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
