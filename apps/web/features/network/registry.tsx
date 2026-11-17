// Rede › Cadastros: o que se configura uma vez e raramente muda (POPs, modelos de ONU, ACS, limiares).
import { useLocation } from "react-router-dom";
import { PageHeading } from "@/components/workspace-ui";
import { useSession } from "@/features/session/provider";
import { can, hasModule } from "@/features/session/model";
import { NetworkPops } from "./pops";
import { OnuCatalogPage } from "./onu-catalog";
import { AcsTemplates } from "./acs-templates";
import { NocThresholds } from "./noc";
import { PageTabs } from "./kit";

export function NetworkRegistry() {
  const { me } = useSession();
  const { pathname } = useLocation();
  const tabs = [
    {
      value: "pops",
      label: "POPs e locais",
      href: "/rede/cadastros/pops",
      show: can(me, "contracts:read"),
    },
    {
      value: "onus",
      label: "Modelos de ONU",
      href: "/rede/cadastros/onus",
      show: hasModule(me, "olt"),
    },
    {
      value: "acs",
      label: "Templates ACS",
      href: "/rede/cadastros/acs",
      show: true,
    },
    {
      value: "limiares",
      label: "Limiares",
      href: "/rede/cadastros/limiares",
      show: hasModule(me, "noc"),
    },
  ].filter((tab) => tab.show);
  const requested = pathname.split("/")[3];
  const tab =
    tabs.find((t) => t.value === requested)?.value ?? tabs[0]?.value ?? "";
  return (
    <>
      <PageHeading
        title="Cadastros de rede"
        description="POPs, modelos de ONU, templates e limiares."
      />
      <PageTabs value={tab} tabs={tabs} />
      {tab === "pops" && <NetworkPops embedded />}
      {tab === "onus" && <OnuCatalogPage embedded />}
      {tab === "acs" && <AcsTemplates embedded />}
      {tab === "limiares" && <NocThresholds />}
    </>
  );
}
