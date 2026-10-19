export type { Subscriber, Invoice, Ticket, WorkOrder, NetworkNode, Activity, RevenuePoint, Snapshot, WorkspaceData } from "./workspace";
export type { CatalogPlan, ServiceContract, ServiceType } from "./commercial";
export type { TechnicalCatalog, OnuModel, OnuTemplate, IpPool, CgnatPlan } from "./technical-catalog";

export const readModelConventions = {
  monetaryUnit: "BRL em reais; o núcleo operacional legado usa centavos e não é conectado às telas",
  dueDay: "Leitura aceita 1–31; comandos legados aceitam 1–28",
  dates: "Datas ISO e instantes com fuso; cenário usa snapshot.asOf, nunca o relógio atual",
  missingValues: "Campos nulos ou ausentes permanecem não informados",
  statuses: "Situações de leitura permanecem extensíveis; filtros são validados pelas opções de cada consulta",
  commercialSource: "catalog indica catálogo explícito; legacy indica projeção dos assinantes, não cadastro novo",
} as const;
