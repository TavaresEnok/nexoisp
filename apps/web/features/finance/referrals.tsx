import useSWR from "swr";
import { z } from "zod";
import { Link } from "react-router-dom";
import { PageHeading } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";

const referralsSchema = z.array(
  z.object({
    referrer_id: z.string().uuid(),
    referrer_name: z.string(),
    referred: z.coerce.number(),
    active: z.coerce.number(),
  }),
);
export function ReferralReport() {
  const result = useSWR("erp-referrals", async () =>
    referralsSchema.parse(await api("/reports/referrals")),
  );
  return (
    <>
      <PageHeading
        title="Relatório de indicações"
        description="Contratos indicados por assinante, conforme os registros do servidor."
      />
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Assinantes indicadores"
          description="Até duzentos indicadores, ordenados por quantidade de contratos. O relatório não gera comissão ou crédito automaticamente."
          columns={["Indicador", "Contratos indicados", "Vigentes"]}
          rows={(result.data ?? []).map((row) => ({
            id: row.referrer_id,
            cells: [row.referrer_name, row.referred, row.active],
            actions: (
              <Button
                size="sm"
                variant="outline"
                render={<Link to={`/assinantes?ficha=${row.referrer_id}`} />}
              >
                Abrir indicador
              </Button>
            ),
          }))}
        />
      </QueryBoundary>
    </>
  );
}
