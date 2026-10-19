import { RecordEditor } from "@/features/shared/record-editor";
import { useSession } from "@/features/session/provider";
import { hasModule } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { drivers, type Device } from "./models";
import { useAgents, useNetworkRefresh } from "./queries";

export function DeviceIdentityEditor({
  device,
  onClose,
}: {
  device: Device;
  onClose: () => void;
}) {
  const { me } = useSession();
  const agents = useAgents();
  const refresh = useNetworkRefresh();
  const integrated = device.driver === "radius";
  const allowedDrivers = Object.entries(drivers).filter(
    ([driver]) =>
      driver === device.driver ||
      (driver !== "radius" &&
        (driver === "mikrotik_radius" ||
          (driver === "olt_huawei" && hasModule(me, "olt")) ||
          (me?.demo &&
            (driver === "demo" ||
              (driver === "olt_demo" && hasModule(me, "olt")))))),
  );
  return (
    <RecordEditor
      title="Editar equipamento de rede"
      description="As alterações atualizam o cadastro no Go. Conversão ao RADIUS integrado e reaplicação das contas são ações separadas."
      initial={{
        name: device.name,
        driver: device.driver,
        host: device.host ?? "",
        api_port: device.api_port == null ? "" : String(device.api_port),
        credential_ref: device.credential_ref ?? "",
        agent_id: device.agent_id ?? "",
      }}
      loading={!integrated && agents.isLoading}
      error={!integrated ? agents.error : undefined}
      retry={() => agents.mutate()}
      fields={[
        {
          key: "name",
          label: "Nome do equipamento",
          required: true,
          maxLength: 80,
        },
        ...(!integrated
          ? [
              {
                key: "driver",
                label: "Integração do equipamento",
                type: "select" as const,
                options: allowedDrivers.map(([value, label]) => ({
                  value,
                  label,
                })),
              },
              {
                key: "host",
                label: "Endereço de gerenciamento",
                maxLength: 200,
              },
              {
                key: "api_port",
                label: "Porta de gerenciamento",
                type: "number" as const,
                min: 1,
                max: 65535,
              },
              {
                key: "credential_ref",
                label: "Referência da credencial local",
                maxLength: 60,
              },
              {
                key: "agent_id",
                label: "Agente responsável",
                type: "select" as const,
                options: [
                  { value: "", label: "Sem agente local" },
                  ...(agents.data ?? [])
                    .filter(
                      (agent) =>
                        !agent.internal &&
                        (agent.status === "active" ||
                          agent.id === device.agent_id),
                    )
                    .map((agent) => ({ value: agent.id, label: agent.name })),
                ],
              },
            ]
          : []),
      ]}
      onClose={onClose}
      onSubmit={async (values) => {
        await api(`/devices/${device.id}`, {
          method: "PATCH",
          body: integrated
            ? { name: values.name }
            : {
                name: values.name,
                driver: values.driver,
                host: values.host || null,
                api_port: values.api_port ? Number(values.api_port) : null,
                credential_ref: values.credential_ref || null,
                agent_id: values.agent_id || null,
              },
        });
        await refresh();
        onClose();
      }}
    />
  );
}
