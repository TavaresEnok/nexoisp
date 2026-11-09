import { z } from "zod";

export const acsVariables = [
  ["pppoe_usuario", "Usuário PPPoE do contrato"],
  ["pppoe_senha", "Senha PPPoE armazenada (mascarada)"],
  ["wifi_ssid", "Nome da rede Wi-Fi informado na aplicação"],
  ["wifi_senha", "Senha do Wi-Fi informada na aplicação (mascarada)"],
  ["contrato_codigo", "Código do contrato"],
  ["assinante_nome", "Nome do assinante"],
] as const;
export const acsTypes = [
  "xsd:string",
  "xsd:boolean",
  "xsd:int",
  "xsd:unsignedInt",
  "xsd:dateTime",
] as const;

export const acsParamSchema = z.object({
  path: z.string(),
  value: z.string(),
  type: z.enum(acsTypes),
});
export type AcsParam = z.infer<typeof acsParamSchema>;
export const acsTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  firmware: z.string(),
  parameters: z.array(acsParamSchema),
  inform_interval: z.number().int().nullable(),
  active: z.boolean(),
  revision: z.number().int(),
  data_model: z.enum(["tr098", "tr181"]).nullable(),
  variables: z.array(z.string()),
  specificity: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AcsTemplate = z.infer<typeof acsTemplateSchema>;
export const acsTemplateListSchema = z.object({
  items: z.array(acsTemplateSchema),
  total: z.number().int(),
});
const deviceSchema = z.object({
  id: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  firmware: z.string(),
  data_model: z.enum(["tr098", "tr181"]),
});
export const acsSuggestionSchema = z.object({
  linked: z.boolean(),
  missing: z.boolean().optional(),
  device: deviceSchema.nullable(),
  suggested_id: z.string().uuid().nullable(),
  templates: z.array(acsTemplateSchema),
});
export const acsPreviewSchema = z.object({
  template: z.object({
    id: z.string().uuid(),
    name: z.string(),
    revision: z.number().int(),
    active: z.boolean(),
  }),
  linked: z.boolean(),
  device: deviceSchema.nullable(),
  device_error: z.string().nullable(),
  matches: z.boolean().nullable(),
  compatible: z.boolean().nullable(),
  data_model: z.enum(["tr098", "tr181"]).nullable(),
  parameters: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
      sensitive: z.boolean(),
      missing: z.array(z.string()),
    }),
  ),
  variables: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      used: z.boolean(),
      available: z.boolean(),
      value: z.string().nullable(),
    }),
  ),
  missing: z.array(z.string()),
  ready: z.boolean(),
});
export type AcsPreview = z.infer<typeof acsPreviewSchema>;

export const dataModelLabel = (value: string | null) =>
  value === "tr098"
    ? "TR-098 (InternetGatewayDevice)"
    : value === "tr181"
      ? "TR-181 (Device)"
      : "Somente inform periódico";

/** Linha do editor: "caminho = valor ; tipo". O tipo padrão é xsd:string. */
export function parseParamLines(text: string): AcsParam[] {
  const out: AcsParam[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const eq = line.indexOf("=");
    if (eq < 1)
      throw new Error(
        `Linha ${index + 1}: use "caminho = valor" ou "caminho = valor ; tipo".`,
      );
    const path = line.slice(0, eq).trim();
    let rest = line.slice(eq + 1).trim();
    let type: AcsParam["type"] = "xsd:string";
    const separator = rest.lastIndexOf(";");
    if (separator >= 0) {
      const candidate = rest.slice(separator + 1).trim();
      if ((acsTypes as readonly string[]).includes(candidate)) {
        type = candidate as AcsParam["type"];
        rest = rest.slice(0, separator).trim();
      }
    }
    out.push({ path, value: rest, type });
  });
  return out;
}
export function formatParamLines(params: AcsParam[]) {
  return params
    .map(
      (p) =>
        `${p.path} = ${p.value}${p.type === "xsd:string" ? "" : ` ; ${p.type}`}`,
    )
    .join("\n");
}
