import type { CoreFrameTab } from "@/components/core-network";
import type { Session } from "@/features/session/model";
import { canAccessPath } from "@/features/operations/navigation";

// Abas de Rede › IP e CGNAT. Concentradores e POPs têm lugar próprio na área de Rede.
export function coreTabs(me: Session | null): CoreFrameTab[] {
  const tabs: CoreFrameTab[] = [
    { value: "pools", href: "/rede/enderecos-ip" },
    { value: "cgnat", href: "/rede/enderecos-ip/planos-de-cgnat" },
  ];
  return tabs.filter((tab) => canAccessPath(me, tab.href));
}
