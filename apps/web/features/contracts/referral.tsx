import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Link } from "react-router-dom";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ActionButton } from "@/features/shared/action";
import { MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import {
  SubscriberPicker,
  type SubscriberChoice,
} from "@/features/shared/subscriber-picker";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { readSubscriber } from "@/data/erp/subscribers";
import { api } from "@/platform/erp-client";
import type { ContractDetail } from "./models";

export function ContractReferral({
  contract,
  refresh,
}: {
  contract: ContractDetail;
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const { mutate } = useSWRConfig();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<SubscriberChoice>({
    subscriber_id: "",
    contract_id: "",
  });
  const id = contract.referred_by_subscriber_id;
  const referrer = useSWR(
    id ? ["erp-subscriber", id] : null,
    ([, subscriberId]) => readSubscriber(subscriberId),
  );
  const save = async (subscriberId: string | null) => {
    await api(`/contracts/${contract.id}/referral`, {
      method: "PUT",
      body: { referrer_subscriber_id: subscriberId },
    });
    setEditing(false);
    await Promise.all([refresh(), mutate("erp-referrals")]);
  };
  return (
    <ProfileSection
      title="Indicação do contrato"
      caption="Assinante que indicou este vínculo comercial."
      action={
        can(me, "contracts:write") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setChoice({ subscriber_id: id ?? "", contract_id: "" });
              setEditing(true);
            }}
          >
            Editar indicação
          </Button>
        )
      }
    >
      <QueryBoundary
        loading={Boolean(id) && referrer.isLoading}
        error={referrer.error}
        retry={() => referrer.mutate()}
      >
        <p>{id ? referrer.data?.name : "Sem indicação registrada."}</p>
      </QueryBoundary>
      <div className="erp-inline-actions">
        {id && can(me, "contracts:write") && (
          <ActionButton
            danger
            confirm="Remover a indicação deste contrato? O histórico de auditoria é preservado."
            onClick={() => save(null)}
          >
            Remover indicação
          </ActionButton>
        )}
        {can(me, "finance:read") && (
          <Button
            variant="outline"
            size="sm"
            render={<Link to="/relatorios/indicacoes" />}
          >
            Relatório de indicações
          </Button>
        )}
      </div>
      {editing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
        >
          <DialogContent className="erp-editor">
            <DialogHeader>
              <DialogTitle>Indicação do contrato</DialogTitle>
              <DialogDescription>
                Selecione o assinante que fez a indicação. O próprio titular não
                pode indicar seu contrato.
              </DialogDescription>
            </DialogHeader>
            <MutationForm
              submit="Salvar indicação"
              onCancel={() => setEditing(false)}
              onSubmit={async () => {
                if (choice.subscriber_id === contract.subscriber_id)
                  throw new Error("Escolha um assinante diferente do titular.");
                await save(choice.subscriber_id);
              }}
            >
              <SubscriberPicker
                includeContracts={false}
                value={choice}
                onChange={setChoice}
              />
            </MutationForm>
          </DialogContent>
        </Dialog>
      )}
    </ProfileSection>
  );
}
