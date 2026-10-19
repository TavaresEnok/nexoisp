import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import { channel, templates } from "./message-models";
export function MessageChannels() {
  const result = useSWR("erp-notice-channels", async () =>
    z.array(channel).parse(await api("/notice-channels")),
  );
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      <OperationalCatalog
        title="Canais de envio ao assinante"
        description="O destino recebe POST JSON com telefone e mensagem. Autorização é cifrada no Go e não reaparece na consulta."
        columns={["Canal", "Endereço", "Campos", "Autenticação", "Situação"]}
        actions={
          <Button onClick={() => setCreating(true)}>Novo canal de envio</Button>
        }
        rows={(result.data ?? []).map((item) => ({
          id: item.id,
          cells: [
            item.name,
            item.url,
            `${item.phone_field} · ${item.message_field}`,
            item.has_headers ? "Configurada" : "Sem cabeçalho",
            item.active ? "Ativo" : "Inativo",
          ],
          actions: (
            <div className="erp-inline-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTesting(item.id)}
              >
                Enviar teste do canal
              </Button>
              <ActionButton
                onClick={async () => {
                  await api(`/notice-channels/${item.id}`, {
                    method: "PATCH",
                    body: { active: !item.active },
                  });
                  await result.mutate();
                }}
              >
                {item.active ? "Desativar canal" : "Ativar canal"}
              </ActionButton>
              <ActionButton
                danger
                confirm="Excluir o canal de envio? O servidor impede a exclusão quando houver regras vinculadas."
                onClick={async () => {
                  await api(`/notice-channels/${item.id}`, {
                    method: "DELETE",
                  });
                  await result.mutate();
                }}
              >
                Excluir canal
              </ActionButton>
            </div>
          ),
        }))}
      />
      {creating && (
        <RecordEditor
          title="Novo canal de envio"
          description="O Go valida HTTPS e os destinos permitidos. A autorização informada será guardada cifrada."
          initial={{
            name: "",
            url: "",
            phone_field: "to",
            message_field: "message",
            auth: "",
          }}
          fields={[
            {
              key: "name",
              label: "Nome do canal",
              required: true,
              maxLength: 60,
            },
            {
              key: "url",
              label: "Endereço do serviço de envio",
              required: true,
              maxLength: 500,
            },
            {
              key: "phone_field",
              label: "Campo do telefone",
              required: true,
              maxLength: 40,
            },
            {
              key: "message_field",
              label: "Campo da mensagem",
              required: true,
              maxLength: 40,
            },
            {
              key: "auth",
              label: "Authorization do canal",
              type: "password",
              maxLength: 500,
            },
          ]}
          onClose={() => setCreating(false)}
          submit="Criar canal"
          onSubmit={async (values) => {
            await api("/notice-channels", {
              body: {
                name: values.name,
                url: values.url,
                phone_field: values.phone_field,
                message_field: values.message_field,
                headers: values.auth ? { Authorization: values.auth } : {},
              },
            });
            setCreating(false);
            await result.mutate();
          }}
        />
      )}
      {testing && (
        <RecordEditor
          title="Teste do canal de envio"
          description="Ao confirmar, uma mensagem será enviada ao telefone informado pelo serviço configurado."
          initial={{ phone: "", message: "Teste de aviso do NexoISP." }}
          fields={[
            {
              key: "phone",
              label: "Telefone do teste",
              required: true,
              maxLength: 20,
            },
            {
              key: "message",
              label: "Mensagem do teste",
              required: true,
              maxLength: 160,
            },
          ]}
          onClose={() => setTesting(null)}
          submit="Enviar teste"
          onSubmit={async (values) => {
            await api(`/notice-channels/${testing}/test`, { body: values });
            setTesting(null);
          }}
        />
      )}
    </QueryBoundary>
  );
}
export function MessageTemplates() {
  const result = useSWR("erp-notice-templates", async () =>
    templates.parse(await api("/notice-templates")),
  );
  const [creating, setCreating] = useState(false);
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      <OperationalCatalog
        title="Modelos de mensagem"
        description={`Variáveis disponíveis: ${(result.data?.variables ?? []).map((value) => `{${value}}`).join(" ")}. A prévia é ilustrativa e não envia mensagens.`}
        columns={["Modelo", "Texto", "Prévia ilustrativa"]}
        actions={
          <Button onClick={() => setCreating(true)}>
            Novo modelo de mensagem
          </Button>
        }
        rows={(result.data?.rows ?? []).map((item) => ({
          id: item.id,
          cells: [item.name, item.body, item.preview],
          actions: (
            <ActionButton
              danger
              confirm="Excluir este modelo? Modelos usados em regras não podem ser excluídos."
              onClick={async () => {
                await api(`/notice-templates/${item.id}`, { method: "DELETE" });
                await result.mutate();
              }}
            >
              Excluir modelo
            </ActionButton>
          ),
        }))}
      />
      {creating && (
        <RecordEditor
          title="Novo modelo de mensagem"
          description={`Variáveis: ${(result.data?.variables ?? []).map((value) => `{${value}}`).join(" ")}`}
          initial={{
            name: "",
            body: "Olá {nome}, sua fatura de {valor} vence em {vencimento}.",
          }}
          fields={[
            {
              key: "name",
              label: "Nome do modelo",
              required: true,
              maxLength: 60,
            },
            {
              key: "body",
              label: "Texto do modelo",
              type: "textarea",
              required: true,
              maxLength: 480,
            },
          ]}
          onClose={() => setCreating(false)}
          submit="Criar modelo"
          onSubmit={async (values) => {
            await api("/notice-templates", { body: values });
            setCreating(false);
            await result.mutate();
          }}
        />
      )}
    </QueryBoundary>
  );
}
