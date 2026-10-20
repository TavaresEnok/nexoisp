import { canonicalErpPath } from "./navigation";
import { hasPage, pageTitles } from "./pages";
export function integrationStatus(pathname: string): "connected" | "pending" {
  return hasPage(canonicalErpPath(pathname)) ? "connected" : "pending";
}
export function operationalTitle(pathname: string): string | undefined {
  return pageTitles[pathname];
}
