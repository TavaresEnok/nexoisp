import type { CoreFrameTab } from "@/components/core-network";
import type { Session } from "@/features/session/model";
import { canAccessPath } from "@/features/operations/navigation";

// Áreas do Core Network do v0 que possuem página conectada ao Go.
export function coreTabs(me: Session | null): CoreFrameTab[] {
  const tabs: CoreFrameTab[] = [
    { value: "pools", href: "/rede/enderecos-ip" },
    { value: "nas", href: "/rede/equipamentos" },
    { value: "cgnat", href: "/rede/enderecos-ip/planos-de-cgnat" },
    { value: "pops", href: "/pops" },
  ];
  return tabs.filter((tab) => canAccessPath(me, tab.href));
}
