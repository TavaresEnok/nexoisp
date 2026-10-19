import { useState } from "react";
import useSWR from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { ContractCatalog } from "@/components/contracts";
import { ConnectedNotice } from "@/features/shared/feedback";
import { ServerPager, useUrlPage } from "@/features/shared/pagination";
import { useSession } from "@/features/session/provider";
import { api, erpClient, download } from "@/platform/erp-client";
import { contractRecordSchema, planSchema, projectContract, projectPlan } from "./models";
import { OperationalContractSheet } from "./sheet";
export function OperationalContracts() {
 const { me } = useSession(); const navigate = useNavigate(); const [params] = useSearchParams(); const [exporting, setExporting] = useState(false);
 const query = params.get("busca") ?? ""; const status = ({ Vigente: "active", Encerrado: "ended" } as Record<string,string>)[params.get("situacao") ?? ""] ?? "";
 const plan = params.get("plano") ?? ""; const subscriber = params.get("assinante") ?? "";
 const { page, setPage } = useUrlPage();
 const filters = new URLSearchParams({ q: query, ...(status ? { status } : {}), ...(plan ? { plan_id: plan } : {}), ...(subscriber ? { subscriber_id: subscriber } : {}) });
 const path = `/contracts?${filters}&limit=8&offset=${page * 8}`;
 const contracts = useSWR(["erp-contracts", path], async ([, path]) => { const result = await erpClient.request<unknown>(path); if (result.total === null) throw new Error("O servidor não informou a contagem de contratos."); return { rows: z.array(contractRecordSchema).parse(result.data), total: result.total }; });
 const catalog = useSWR("erp-plans", async () => z.array(planSchema).parse(await api("/plans")));
 const rows = contracts.data?.rows ?? []; const names = Array.from(new Map(rows.map(contract => [contract.subscriber_id, { id: contract.subscriber_id, name: contract.subscriber_name }])).values());
 return <><ConnectedNotice demo={me?.demo} /><ContractCatalog operational plans={(catalog.data ?? []).map(projectPlan)} contracts={rows.map(contract => projectContract(contract))} subscribers={names} total={contracts.data?.total} loading={contracts.isLoading || catalog.isLoading} error={contracts.error || catalog.error} openSubscriber={id => navigate(`/assinantes?ficha=${id}`)} onOpen={contract => navigate(`/contratos?${new URLSearchParams({ ...Object.fromEntries(params), contrato: contract.id })}`)} onExport={async () => { setExporting(true); try { await download(`/contracts?${filters}&format=csv&limit=5000`, "contratos.csv"); } catch (error) { toast.error((error as Error).message); } finally { setExporting(false); } }} exportBusy={exporting} pagination={<ServerPager page={page} setPage={setPage} total={contracts.data?.total ?? 0} loading={contracts.isLoading} />} />{params.get("contrato") && <OperationalContractSheet id={params.get("contrato")!} onClose={() => { const next = new URLSearchParams(params); next.delete("contrato"); navigate(`/contratos?${next}`, { replace: true }); }} />}</>;
}
