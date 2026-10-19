import {
  navigationAreas,
  searchNavigation,
  type NavigationNode,
} from "@/lib/navigation";
import { normalize } from "@/lib/format";

// Extensões operacionais não alteram o catálogo da demonstração original.
const referrals: NavigationNode = {
  href: "/relatorios/indicacoes",
  label: "Indicações",
  sourceLabel: "Indicações",
  area: "Financeiro",
  audience: "Equipe",
  trail: ["Financeiro", "Indicações"],
  parentHref: null,
  moduleHref: "/relatorios/indicacoes",
  children: [],
};
export function operationalNavigationAreas() {
  return navigationAreas.map((area) =>
    area.id === "financeiro"
      ? { ...area, pages: [...area.pages, referrals] }
      : area,
  );
}
export function findOperationalPage(path: string) {
  return path === referrals.href ? referrals : undefined;
}
export function searchOperationalNavigation(query: string) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return [
    ...searchNavigation(query),
    ...(terms.every((term) =>
      normalize(referrals.trail.join(" ")).includes(term),
    )
      ? [referrals]
      : []),
  ];
}
