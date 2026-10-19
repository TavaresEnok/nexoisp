export function integrationStatus(pathname: string): "connected" | "pending" {
 return ["/", "/assinantes", "/conta", "/financeiro/faturas", "/financeiro/conciliacao", "/financeiro/politica-de-cobranca", "/relatorios/cobranca", "/planos", "/contratos", "/produtos-adicionais", "/estrutura"].includes(pathname) ? "connected" : "pending";
}
