import type { Session } from "@/features/session/model";
import { canAccessPath } from "./navigation";

/** Destino interno solicitado antes do login, quando a conta pode acessá-lo. */
export function returnPath(me: Session | null, state: unknown): string | null {
  const from =
    state && typeof state === "object" && "from" in state
      ? (state as { from: unknown }).from
      : null;
  if (
    typeof from !== "string" ||
    !from.startsWith("/") ||
    from.startsWith("//") ||
    from.includes("\\")
  )
    return null;
  const path = from.split(/[?#]/)[0];
  if (path === "/login" || !canAccessPath(me, path)) return null;
  return from;
}
