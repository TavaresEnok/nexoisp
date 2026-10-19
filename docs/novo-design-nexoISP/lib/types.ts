export type { Subscriber, Invoice, Ticket, WorkOrder, NetworkNode, Activity, RevenuePoint, Snapshot, WorkspaceData } from "../domain/workspace";

export type Section =
  | "inicio"
  | "assinantes"
  | "financeiro"
  | "atendimentos"
  | "operacoes"
  | "rede"
  | "planos"
  | "relatorios"
  | "configuracoes"
  | "acompanhamento";
export const sectionLabels: Record<Section, string> = {
  inicio: "Visão geral",
  assinantes: "Assinantes",
  financeiro: "Financeiro",
  atendimentos: "Atendimentos",
  operacoes: "Operações de campo",
  rede: "Rede e NOC",
  planos: "Catálogo de planos",
  relatorios: "Relatórios",
  configuracoes: "Configurações",
  acompanhamento: "Consolidação e evidências",
};
