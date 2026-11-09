import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api, download } from "@/platform/erp-client";
import {
  fileToBase64,
  formatMeters,
  maxUploadBytes,
  otdrEventLabel,
  otdrEventTypes,
  otdrListSchema,
  otdrSchema,
  parseEventsText,
  wavelengths,
  type CableDetail,
} from "./ftth-design-models";

export function useCableRefresh() {
  const { mutate } = useSWRConfig();
  return () =>
    mutate(
      (key) =>
        Array.isArray(key) &&
        [
          "erp-ftth-cables",
          "erp-ftth-cable",
          "erp-ftth-otdr",
          "erp-ftth-fusions",
          "erp-map-cables",
        ].includes(key[0]),
    );
}
const decimal = (value: string) => Number(value.trim().replace(",", "."));

export function CableOtdr({ cable }: { cable: CableDetail }) {
  const { me } = useSession();
  const write = can(me, "network:write") && cable.active;
  const path = `/ftth/cables/${cable.id}/otdr`;
  const result = useSWR(["erp-ftth-otdr", cable.id], async () =>
    otdrListSchema.parse(await api(path)),
  );
  const refresh = useCableRefresh();
  const [creating, setCreating] = useState(false);
  return (
    <ProfileSection
      title="Medições OTDR"
      caption="Registros por fibra com arquivo bruto privado opcional (.sor ou outro, até 5 MB)."
      action={
        write && (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            Registrar medição OTDR
          </Button>
        )
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "Data",
                  "Fibra",
                  "Onda",
                  "Distância",
                  "Perda",
                  "Eventos",
                  "Técnico",
                  "Arquivo",
                ].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    {new Date(`${m.measured_on}T12:00:00`).toLocaleDateString(
                      "pt-BR",
                    )}
                  </TableCell>
                  <TableCell>{m.fiber}</TableCell>
                  <TableCell>{m.wavelength_nm} nm</TableCell>
                  <TableCell>{formatMeters(m.total_distance_m)}</TableCell>
                  <TableCell>
                    {m.total_loss_db.toLocaleString("pt-BR")} dB
                  </TableCell>
                  <TableCell>
                    {m.events.length
                      ? m.events
                          .map(
                            (e) =>
                              `${formatMeters(e.distance_m)} ${otdrEventLabel(e.type)} ${e.loss_db.toLocaleString("pt-BR")} dB`,
                          )
                          .join(" · ")
                      : "Sem eventos"}
                    {m.notes && (
                      <small className="table-subline">{m.notes}</small>
                    )}
                  </TableCell>
                  <TableCell>{m.technician}</TableCell>
                  <TableCell>
                    {m.file_name ? (
                      <ActionButton
                        label={`Baixar arquivo ${m.file_name}`}
                        onClick={async () => {
                          await download(`${path}/${m.id}/file`, m.file_name!);
                        }}
                      >
                        Baixar
                      </ActionButton>
                    ) : (
                      "Sem arquivo"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="profile-footnote">
            Nenhuma medição OTDR registrada para este cabo.
          </p>
        )}
      </QueryBoundary>
      {creating && (
        <OtdrEditor
          cable={cable}
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await Promise.all([result.mutate(), refresh()]);
          }}
        />
      )}
    </ProfileSection>
  );
}

function OtdrEditor({
  cable,
  onClose,
  onDone,
}: {
  cable: CableDetail;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [values, setValues] = useState({
    fiber: "1",
    measured_on: new Date().toLocaleDateString("sv-SE"),
    wavelength_nm: "1550",
    total_distance_m: "",
    total_loss_db: "",
    events: "",
    technician: "",
    notes: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Registrar medição OTDR</DialogTitle>
          <DialogDescription>
            {cable.name} · {cable.fiber_count} fibra(s). O arquivo bruto fica
            privado e só é baixado com sessão autenticada.
          </DialogDescription>
        </DialogHeader>
        <MutationForm
          onCancel={onClose}
          onSubmit={async () => {
            const fiber = Number(values.fiber);
            if (
              !Number.isInteger(fiber) ||
              fiber < 1 ||
              fiber > cable.fiber_count
            )
              throw new Error(`Informe uma fibra de 1 a ${cable.fiber_count}.`);
            const distance = decimal(values.total_distance_m),
              loss = decimal(values.total_loss_db);
            if (!Number.isFinite(distance) || distance <= 0)
              throw new Error("Informe a distância total em metros.");
            if (!Number.isFinite(loss) || loss < 0)
              throw new Error("Informe a perda total em dB.");
            const events = parseEventsText(values.events);
            if (file && file.size > maxUploadBytes)
              throw new Error("O arquivo deve ter até 5 MB.");
            otdrSchema.parse(
              await api(`/ftth/cables/${cable.id}/otdr`, {
                body: {
                  fiber,
                  measured_on: values.measured_on,
                  wavelength_nm: Number(values.wavelength_nm),
                  total_distance_m: distance,
                  total_loss_db: loss,
                  events,
                  technician: values.technician.trim(),
                  notes: values.notes.trim(),
                  ...(file
                    ? {
                        file_name: file.name,
                        file_content_base64: await fileToBase64(file),
                      }
                    : {}),
                },
              }),
            );
            await onDone();
          }}
        >
          <div className="erp-columns">
            <FormField label="Fibra medida">
              <Input
                type="number"
                min={1}
                max={cable.fiber_count}
                required
                value={values.fiber}
                onChange={(e) => set("fiber")(e.target.value)}
              />
            </FormField>
            <FormField label="Data da medição">
              <Input
                type="date"
                required
                value={values.measured_on}
                onChange={(e) => set("measured_on")(e.target.value)}
              />
            </FormField>
            <FormField label="Comprimento de onda">
              <select
                className="commercial-select"
                value={values.wavelength_nm}
                onChange={(e) => set("wavelength_nm")(e.target.value)}
              >
                {wavelengths.map((w) => (
                  <option key={w} value={w}>
                    {w} nm
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Distância total (m)">
              <Input
                inputMode="decimal"
                required
                value={values.total_distance_m}
                onChange={(e) => set("total_distance_m")(e.target.value)}
              />
            </FormField>
            <FormField label="Perda total (dB)">
              <Input
                inputMode="decimal"
                required
                value={values.total_loss_db}
                onChange={(e) => set("total_loss_db")(e.target.value)}
              />
            </FormField>
            <FormField label="Técnico responsável">
              <Input
                required
                maxLength={120}
                value={values.technician}
                onChange={(e) => set("technician")(e.target.value)}
              />
            </FormField>
          </div>
          <FormField
            label="Eventos da medição"
            hint={`Um por linha: "distância em metros; perda em dB; tipo". Tipos: ${otdrEventTypes.map((t) => t.label).join(", ")}.`}
          >
            <Textarea
              rows={4}
              value={values.events}
              onChange={(e) => set("events")(e.target.value)}
            />
          </FormField>
          <FormField label="Observações da medição">
            <Textarea
              maxLength={500}
              value={values.notes}
              onChange={(e) => set("notes")(e.target.value)}
            />
          </FormField>
          <FormField
            label="Arquivo bruto da medição"
            hint="Opcional; .sor ou outro formato, até 5 MB."
          >
            <Input
              type="file"
              onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
            />
          </FormField>
        </MutationForm>
      </DialogContent>
    </Dialog>
  );
}
