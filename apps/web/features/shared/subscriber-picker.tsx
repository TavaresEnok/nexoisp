import { useState } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { FormField } from "./form";
import { QueryBoundary } from "./feedback";
import { api } from "@/platform/erp-client";
import { readSubscriber } from "@/data/erp/subscribers";
export type SubscriberChoice = { subscriber_id: string; contract_id: string };
export function SubscriberPicker({
  value,
  onChange,
  includeContracts = true,
}: {
  value: SubscriberChoice;
  onChange: (next: SubscriberChoice) => void;
  includeContracts?: boolean;
}) {
  const [query, setQuery] = useState("");
  const rows = useSWR(
    query.trim().length >= 2 ? ["erp-subscriber-pick", query.trim()] : null,
    ([, q]) =>
      api<{ id: string; name: string }[]>(
        `/subscribers?limit=20&q=${encodeURIComponent(q)}`,
      ),
  );
  const detail = useSWR(
    value.subscriber_id ? ["erp-subscriber", value.subscriber_id] : null,
    ([, id]) => readSubscriber(id),
  );
  return (
    <div className="erp-stack">
      <div className="erp-columns">
        <FormField label="Buscar assinante">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nome, documento ou telefone"
          />
        </FormField>
        <FormField label="Assinante selecionado">
          <select
            className="commercial-select"
            required
            value={value.subscriber_id}
            onChange={(e) =>
              onChange({ subscriber_id: e.target.value, contract_id: "" })
            }
          >
            <option value="">
              {rows.isLoading
                ? "Consultando…"
                : rows.data?.length === 0
                  ? "Nenhum resultado"
                  : "Selecione um assinante"}
            </option>
            {detail.data &&
              !rows.data?.some((row) => row.id === detail.data!.id) && (
                <option value={detail.data.id}>{detail.data.name}</option>
              )}
            {rows.data?.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </FormField>
        {includeContracts && (
          <FormField label="Contrato vinculado (opcional)">
            <select
              className="commercial-select"
              value={value.contract_id}
              disabled={!value.subscriber_id || detail.isLoading}
              onChange={(e) =>
                onChange({ ...value, contract_id: e.target.value })
              }
            >
              <option value="">Sem contrato específico</option>
              {detail.data?.contracts.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.plan_name} · {contract.id.slice(0, 8)}
                  {contract.status === "ended" ? " · Encerrado" : ""}
                </option>
              ))}
            </select>
          </FormField>
        )}
      </div>
      <QueryBoundary
        error={rows.error || detail.error}
        retry={() => Promise.all([rows.mutate(), detail.mutate()])}
      >
        {null}
      </QueryBoundary>
    </div>
  );
}
