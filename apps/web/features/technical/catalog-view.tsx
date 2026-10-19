import { OnuCatalog } from "@/components/onu-catalog";
import { CoreNetwork } from "@/components/core-network";
import type { CoreTab, TechnicalCatalog } from "@/domain/technical-catalog";

export type TechnicalMode = "models" | "templates" | CoreTab;

export function TechnicalCatalogView({ catalog, mode }: { catalog: TechnicalCatalog; mode: TechnicalMode }) {
  return mode === "models" || mode === "templates"
    ? <OnuCatalog catalog={catalog} initialTab={mode} />
    : <CoreNetwork catalog={catalog} initialTab={mode} />;
}
