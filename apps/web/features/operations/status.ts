export function integrationStatus(pathname: string): "connected" | "pending" {
 return ["/", "/assinantes", "/conta", "/estrutura"].includes(pathname) ? "connected" : "pending";
}
