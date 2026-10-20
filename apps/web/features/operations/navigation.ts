import { can, hasModule, type Session } from "@/features/session/model";
import { catalogueAllows, catalogueTarget } from "./catalogue";
import { pageAccess, pageAliases } from "./pages";
export const erpAliases = pageAliases;
export function canonicalErpPath(path: string) {
  const target = catalogueTarget(path);
  return erpAliases[path] ?? erpAliases[target] ?? target;
}
export function canAccessPath(me: Session | null, pathname: string): boolean {
  if (!me) return false;
  if (pathname === "/rede/ftth/fttx-olt" && !hasModule(me, "olt")) return false;
  if (!catalogueAllows(me, pathname)) return false;
  const access = pageAccess(canonicalErpPath(pathname));
  if (access === "conta") return true;
  if (me.mfa_pending) return false;
  if (access === "saas") return can(me, "tenants:manage") && !me.support;
  if (access === "portal") return can(me, "portal:self");
  if (!me.tenant || me.role === "subscriber") return false;
  if (access === "equipe") return true;
  return Boolean(
    Array.isArray(access) &&
      can(me, access[0]) &&
      (!access[1] || hasModule(me, access[1])),
  );
}
