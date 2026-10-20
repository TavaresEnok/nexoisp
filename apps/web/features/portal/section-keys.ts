// Destinos /portal/<seção> do menu do v0; home.tsx associa cada um à sua seção.
export const portalSectionKeys = [
  "planos",
  "consumo",
  "faturas",
  "dados",
  "wifi",
  "religar",
  "atendimento",
  "documentos",
  "satisfacao",
] as const;
export type PortalSectionKey = (typeof portalSectionKeys)[number];
