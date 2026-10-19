export const originIds = ["8001", "8002", "8004", "8006", "8008", "8015", "8021", "8022", "8026"] as const;
export type FeatureStage = "Consulta parcial" | "Núcleo preparado" | "Pendente";
export type Feature = {
  id: string; name: string; origins: readonly string[]; originalRoute: string; route: string | null;
  scope: string; stage: FeatureStage; implementation: string[]; tests: string[]; remaining: string;
  acceptance: { interface: boolean; businessRules: boolean; authorizedPersistence: boolean; endToEnd: boolean };
  disposition: "Mantido" | "Adaptado";
  decision: string;
};
const rows: [string, string, string, string, string][] = [
  ["A01", "Shell e navegação", "8001,8002,8004,8021,8022,8015,8026", "/", "Sidebar, navegação móvel, breadcrumbs, favoritos, provedor, perfil e ajuda."],
  ["A02", "Busca e comandos", "Todas", "/", "Páginas, ações, nome, documento, telefone, e-mail, PPPoE, IP, MAC e serial."],
  ["A03", "Notificações e produtividade", "8001,8002,8004,8015,8021,8026", "/auditoria", "Não lidas, marcar uma ou todas, ocorrência e criação rápida."],
  ["A04", "Aparência e padrões", "8001,8021", "/configuracoes", "Claro, escuro, sistema e densidade persistidos."],
  ["A05", "Identidade e acesso", "8001,8002,8004,8021,8022", "/acesso", "Entrada, saída, perfis e portais. Substituir personas simuladas por autorização real."],
  ["A06", "Estados comuns", "Todas", "/", "Carregamento, vazio, erro, validação, confirmação e desfazer."],
  ["B01", "Panorama", "Todas", "/", "KPIs, evolução, caixa, óptica, disponibilidade, atividade e prioridades."],
  ["B02", "Fila do dia", "8001,8022", "/fila", "Lista e quadro, responsável, prioridade, SLA, concluir, adiar e desfazer."],
  ["B03", "Relatórios consolidados", "8002,8004,8006,8021", "/relatorios", "Período, provedor, POP, exportação e definições das métricas."],
  ["C01", "Assinantes", "Todas", "/assinantes", "Cadastro e edição vinculados a contrato, fatura e operação; filtros e exportação."],
  ["C02", "Ficha 360°", "8001,8002,8004,8006,8015,8021,8022,8026", "/assinantes/[id]", "Dados, contratos, financeiro, conexão, contatos, notas, documentos, chamados, OS e histórico."],
  ["C03", "Planos versionados", "8002,8004,8006,8008,8021,8022", "/planos", "Criar, revisar e retirar da oferta preservando preços e vínculos históricos."],
  ["C04", "Contratos", "8002,8004,8006,8021,8022", "/contratos", "Múltiplos contratos, acesso desejado e observado, condições e histórico."],
  ["C05", "Ciclo comercial", "8006,8002,8004,8022", "/contratos", "Plano e vencimento agendados, cancelamento, descontos, aditivos, restrição e encerramento."],
  ["C06", "Acesso do contrato", "8001,8002,8004,8006,8021,8022", "/assinantes/[id]", "Solicitações e evidências separadas de conexão observada; provisionamento e reativação."],
  ["C07", "Prospectos", "8002,8004,8006,8022", "/prospectos", "Funil, origem, contatos, propostas, negociação, perda e conversão."],
  ["D01", "Atendimentos", "8002,8004,8015,8021,8022", "/atendimentos", "Abrir, assumir, aguardar, resolver, reabrir; notas internas e respostas distintas."],
  ["D02", "Ordens de serviço", "8002,8004,8015,8021,8022", "/ordens", "Criar, atribuir, reagendar, iniciar, concluir, cancelar, materiais e evidências."],
  ["D03", "Agenda de campo", "8002,8004,8006,8021", "/agenda", "Técnicos, duração, disponibilidade e prevenção de sobreposição."],
  ["D04", "Meu trabalho", "8002,8004,8022", "/meu-trabalho", "Visitas, execução móvel, notas, materiais e checklist."],
  ["D05", "Estoque", "8002,8004,8015,8021,8022", "/estoque", "Saldo, mínimos, serial, movimentos, comodato e consumo por OS."],
  ["D06", "Relatórios de atendimento", "8002,8004,8021,8022", "/relatorios/atendimento", "Categoria, origem, resposta, SLA, produtividade e satisfação."],
  ["E01", "Visão financeira", "8008,8015,8021,8022,8026", "/financeiro", "Recorrência, faturamento e recebimento distintos; fluxo e pendências."],
  ["E02", "Faturas", "8001,8002,8004,8015,8021,8022,8026", "/financeiro/faturas", "Competência, detalhe, baixa sem duplicação, negociação e cancelamento."],
  ["E03", "Conciliação", "8002,8004,8021,8022", "/financeiro/conciliacao", "Comprovantes, valores, divergência, confirmação, rejeição e exportação."],
  ["E04", "Política de cobrança", "8001,8002,8004,8022", "/financeiro/politica", "Mensalidades, avisos, redução, suspensão, religação, juros e confiança."],
  ["E05", "Relatórios de cobrança", "8002,8004,8022", "/relatorios/cobranca", "Aging, recebido por plano, meios e contratos sem fatura."],
  ["F01", "Centro NOC", "8001,8002,8004,8015,8021,8022,8026", "/rede/noc", "Alertas, infraestrutura, tráfego, óptica, disponibilidade e impacto."],
  ["F02", "Limiares e correlação", "8022", "/rede/limiares", "RX, idade da leitura, falha coletiva, limiares e evidências."],
  ["F03", "Equipamentos e agentes", "8001,8002,8004,8015,8021,8022,8026", "/rede/equipamentos", "NAS, OLT, switch, POP, recursos, uptime, agentes e divergências."],
  ["F04", "OLTs e ONUs", "8001,8002,8004,8006,8022", "/rede/onus", "Autorização, serial, contrato, RX, TX, PON, VLAN e histórico."],
  ["F05", "Rede óptica", "8002,8004,8021,8022", "/rede/optica", "Mapa, topologia, lista acessível, caixas, portas, reservas e vínculos."],
  ["F06", "IPAM e CGNAT", "8002,8004,8021,8022", "/rede/ipam", "IPv4, IPv6, reservas, rastreabilidade, CIDR e sobreposição."],
  ["F07", "Operações de rede", "8006,8008,8021,8022", "/rede/operacoes", "Estados, evidências, incerteza, tentativas e verificação antes de repetir."],
  ["F08", "Manutenções", "8002,8004,8006", "/rede/manutencoes", "Janela, equipamentos, POP, impacto, responsável e avisos."],
  ["F09", "Sessões online", "8002,8004,8006,8022", "/rede/sessoes", "PPPoE, IP, duração, motivo, consumo e idade da leitura."],
  ["F10", "POPs", "8002,8004,8006", "/rede/pops", "Cadastro, endereço, contato, equipamentos, contratos e saúde."],
  ["G01", "Usuários e papéis", "8001,8002,8004,8021,8022", "/gestao/usuarios", "Usuários, perfis, convites, permissões, segurança e histórico."],
  ["G02", "Avisos da equipe", "8001,8002,8004,8022", "/gestao/avisos", "Canais, eventos, destinatários, leitura e histórico."],
  ["G03", "Mensagens ao assinante", "8002,8004,8006", "/gestao/mensagens", "Modelos, variáveis, canais, consentimento, janela e entregas."],
  ["G04", "Integrações e API", "8002,8004,8006", "/gestao/integracoes", "Escopos, limites, validade, revogação, webhooks e reexecução."],
  ["G05", "Catálogos e SLA", "8002,8004", "/gestao/catalogos", "Categorias, motivos, SLA, escalonamento, campos e kits."],
  ["G06", "Importação CSV", "8002,8004,8006,8021", "/gestao/importacao", "Mapeamento, validação, prévia, duplicidade, lotes e erros por linha."],
  ["G07", "Auditoria", "8001,8002,8004,8021,8022", "/auditoria", "Entidade, ação, data, autor, provedor, antes, depois e exportação."],
  ["G08", "Provedores", "8001,8002,8004,8022", "/gestao/provedores", "Identidade, módulos, saúde, suporte e isolamento de dados."],
  ["G09", "Conta e configurações", "8001,8002,8004,8021,8022", "/configuracoes", "Perfil, identidade, fuso, densidade, tema, senha e armazenamento."],
  ["G10", "Design system e cobertura", "8001", "/acompanhamento", "Tokens, componentes, estados, origens, evidências e pendências."],
  ["H01", "Portal independente", "8002,8004,8006,8021,8022", "/portal", "Dados, planos, faturas, consumo, chamados e isolamento."],
  ["H02", "Ações do portal", "8002,8004,8006,8021,8022", "/portal", "Chamados, contatos, demonstrativos, avisos e avaliação."],
];
const consultations: Record<string, [route: string, ...files: string[]]> = {
  A01: ["/", "components/app-shell.tsx"], A02: ["/", "components/app-shell.tsx", "lib/subscriber-search.ts"], A03: ["/", "components/app-shell.tsx"], A04: ["/configuracoes", "components/app-shell.tsx"], A06: ["/", "components/workspace-feedback.tsx", "components/workspace-data-boundary.tsx", "components/workspace-provider.tsx", "lib/workspace-schema.ts"],
  B01: ["/", "components/overview.tsx"], B03: ["/relatorios", "components/management.tsx"],
  C01: ["/assinantes", "components/subscribers.tsx"], C02: ["/assinantes", "components/subscriber-sheet.tsx", "components/subscriber-history.tsx", "lib/subscriber-history.ts", "lib/use-query-state.ts"], C03: ["/planos", "components/plans.tsx", "components/plan-details.tsx"], C04: ["/contratos", "components/contracts.tsx", "components/contract-details.tsx"], C06: ["/assinantes", "components/subscriber-sheet.tsx", "components/subscriber-contracts.tsx"],
  D01: ["/atendimentos", "components/support.tsx"], D02: ["/ordens-de-servico", "components/field-operations.tsx"], D03: ["/ordens-de-servico", "components/field-operations.tsx"],
  E01: ["/financeiro/faturas", "components/financial.tsx"], E02: ["/financeiro/faturas", "components/financial.tsx"],
  F01: ["/rede/equipamentos", "components/network-center.tsx"], F03: ["/rede/equipamentos", "components/network-center.tsx", "components/technical-workspace.tsx"],
  F04: ["/rede/ftth/fttx-olt", "components/optical-network.tsx"], F05: ["/rede/mapa", "components/network-explorer.tsx", "components/network-leaflet-map.tsx"],
  F06: ["/rede/enderecos-ip/blocos-de-enderecos", "components/technical-workspace.tsx", "components/ip-traceability.tsx"], F09: ["/rede/online", "components/network-explorer.tsx", "components/network-online.tsx"],
  G09: ["/configuracoes", "components/management.tsx"], G10: ["/acompanhamento", "components/consolidation-progress.tsx"],
};
export const standaloneRoutes = ["/relatorios", "/configuracoes", "/acompanhamento"] as const;
const prepared: Record<string, string> = {
  C01: "Cadastro integrado, edição e notas têm regras testadas e repositório transacional no Neon; faltam sessão verificada e formulário de escrita.",
  C03: "Versões e disponibilidade têm testes e repositório privado preparado; faltam sessão verificada, interface de edição e condições comerciais.",
  C05: "Agendamento e cancelamento têm testes; descontos, aditivos e encerramento permanecem pendentes.",
  C06: "Intenção e evidência simulada estão separadas no núcleo persistível; faltam sessão verificada e interface de execução. Não há contato com equipamento real.",
  D01: "Abertura, transições e notas têm testes; atendimento e nota também foram persistidos em teste real no Neon. Faltam sessão, interface mutável e SLA completo.",
  D02: "Criação, reagendamento e conclusão têm regras testadas; criação também foi persistida no Neon. Faltam sessão, materiais, checklist e interface de escrita.",
  D03: "Sobreposição é recusada nos testes de domínio e persistência. Faltam visões de agenda e gravação por sessão autenticada; concorrência entre conexões não foi testada.",
  E01: "Seletores financeiros do núcleo são testados; a interface pública ainda usa o cenário de consulta existente.",
  E02: "Baixa, recibos de requisição e proteção contra repetição passaram no Neon com rollback. Faltam sessão verificada, interface de escrita, negociação e conciliação.",
  F07: "Verificação, incerteza e obsolescência têm testes; o repositório está preparado, sem rota pública de execução nem contato com equipamento real.",
  G07: "Eventos são persistidos junto aos comandos, com autoria recebida do servidor. Falta vincular essa autoria à sessão verificada e criar a consulta; não é auditoria imutável.",
};
export const features: Feature[] = rows.map(([id, name, origins, originalRoute, scope]) => {
  const consultation = consultations[id], hasCore = Boolean(prepared[id]);
  return {
    id, name, origins: origins === "Todas" ? originIds : origins.split(","), originalRoute, scope, route: consultation?.[0] ?? null,
    stage: hasCore ? "Núcleo preparado" : consultation ? "Consulta parcial" : "Pendente",
    implementation: [...(consultation ? consultation.slice(1) : []), ...(hasCore ? ["lib/operations/domain.ts", "lib/operations/schema.ts", "lib/operations/repository.ts", "lib/operations/persistence-schema.ts", "lib/db/schema.ts"] : [])],
    tests: hasCore ? ["tests/operations.test.ts", "tests/persistence-schema.test.ts", "tests/integration/private-workspace.test.ts"] : ["A02", "A06", "C02"].includes(id) ? ["tests/workspace-schema.test.ts"] : id === "G10" ? ["tests/consolidation.test.ts"] : [],
    acceptance: { interface: Boolean(consultation), businessRules: hasCore, authorizedPersistence: false, endToEnd: false },
    disposition: consultation && consultation[0] !== originalRoute ? "Adaptado" : "Mantido",
    decision: consultation && consultation[0] !== originalRoute ? "Consulta reorganizada na navegação atual; a rota original é preservada apenas como referência de escopo." : "Escopo preservado; existência de arquivos não comprova conclusão integral.",
    remaining: prepared[id] ?? (consultation ? "Cobertura parcial. Não comprova o escopo completo nem operações persistidas." : "Ainda não implementado nesta versão. Presença na origem não conta como entrega atual."),
  };
});
export function filterFeatures(query: string, stage: string) {
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const search = normalize(query.trim());
  return features.filter(feature => (stage === "Todos" || feature.stage === stage) && normalize(`${feature.id} ${feature.name} ${feature.scope} ${feature.origins.join(" ")}`).includes(search));
}
