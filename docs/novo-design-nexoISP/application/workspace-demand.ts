import { resolveNavigationRoute } from "../lib/navigation-route";
import type { NavigationView } from "../lib/navigation";

export const viewDataRequirements = {
  overview: "workspace",
  subscribers: "workspace",
  plans: "workspace",
  contracts: "workspace",
  financial: "workspace",
  support: "workspace",
  field: "workspace",
  network: "workspace",
  "network-online": "workspace",
  "network-map": "workspace",
  "network-olt": "workspace",
  "network-pon": "workspace",
  "network-cto": "workspace",
  "network-ip": "workspace",
  "network-onu-models": "technical",
  "network-onu-templates": "technical",
  "network-pools": "technical",
  "network-nas": "technical",
  "network-cgnat": "technical",
  settings: "workspace",
} as const satisfies Record<NavigationView, "workspace" | "technical">;

export function needsWorkspaceData(pathname: string, requested: boolean, subscriberId: string | null): boolean {
  if (requested || subscriberId) return true;
  const route = resolveNavigationRoute(pathname);
  if (route.kind === "view") return viewDataRequirements[route.view] === "workspace";
  return route.kind === "special" && (route.entry === "reports" || route.entry === "settings");
}
