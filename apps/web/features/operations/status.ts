export function integrationStatus(pathname: string): "connected" | "pending" {
  if (pathname.startsWith("/portal/")) return "connected";
  return [
    "/configuracoes",
    "/administracao/importacao",
    "/administracao/integracoes",
    "/administracao/avisos",
    "/administracao/avisos-assinante",
    "/portal",
    "/provedores",
    "/administracao/anatel",
    "/auditoria",
    "/administracao/catalogos-sla",
    "/administracao/usuarios",
    "/administracao/empresas",
    "/rede/mapa",
    "/rede/consulta-ip",
    "/rede/enderecos-ip/planos-de-cgnat",
    "/rede/enderecos-ip",
    "/rede/enderecos-ip/blocos-de-enderecos",
    "/rede/ftth",
    "/rede/ftth/fttx-cto",
    "/busca",
    "/pops",
    "/rede/manutencoes",
    "/rede/onus",
    "/rede/ftth/fttx-onu",
    "/noc",
    "/rede/online",
    "/rede/equipamentos",
    "/rede/operacoes",
    "/estoque",
    "/ordens-de-servico",
    "/agenda",
    "/meu-trabalho",
    "/",
    "/assinantes",
    "/conta",
    "/financeiro/faturas",
    "/financeiro/conciliacao",
    "/financeiro/politica-de-cobranca",
    "/relatorios/cobranca",
    "/prospectos",
    "/atendimentos",
    "/relatorios/atendimento",
    "/planos",
    "/contratos",
    "/produtos-adicionais",
    "/estrutura",
  ].includes(pathname)
    ? "connected"
    : "pending";
}
export function operationalTitle(pathname: string): string | undefined {
  return (
    {
      "/noc": "NOC",
      "/pops": "Pontos de presença",
      "/rede/onus": "ONUs e autorizações",
      "/rede/ftth/fttx-onu": "ONUs e autorizações",
      "/rede/manutencoes": "Manutenções",
      "/rede/operacoes": "Operações de rede",
      "/estoque": "Estoque",
      "/agenda": "Agenda",
      "/meu-trabalho": "Meu trabalho",
      "/busca": "Busca",
    } as Record<string, string>
  )[pathname];
}
