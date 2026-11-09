import { useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { Panel } from "@/components/workspace-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import {
  cableKindLabel,
  cableKinds,
  fileToBase64,
  formatMeters,
  kmlApplySchema,
  kmlPreviewSchema,
  maxUploadBytes,
  type KmlPreview,
} from "./ftth-design-models";
import { usePops } from "./ftth-cables";

type ImportRequest = {
  pop_id: string;
  file_name: string;
  content_base64: string;
  box_kind: string;
  box_ports: number;
  cable_kind: string;
  cable_fibers: number;
};
const situation = (errors: string[]) =>
  errors.length ? errors.join("; ") : "Pronto para importar";

export function KmlImport() {
  const { mutate } = useSWRConfig();
  const pops = usePops();
  const [values, setValues] = useState({
    pop_id: "",
    box_kind: "cto",
    box_ports: "8",
    cable_kind: "aerial",
    cable_fibers: "12",
  });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{
    request: ImportRequest;
    result: KmlPreview;
  } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (key: keyof typeof values) => (value: string) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setPreview(null);
  };
  const errorCount = preview
    ? [...preview.result.boxes, ...preview.result.cables].filter(
        (item) => item.errors.length,
      ).length
    : 0;
  return (
    <Panel
      title="Importação de projeto GIS (KML)"
      description="Pontos do arquivo viram caixas candidatas e linhas viram cabos candidatos do POP escolhido. A prévia não grava; a aplicação grava tudo numa única operação ou nada."
    >
      <QueryBoundary
        loading={pops.isLoading}
        error={pops.error}
        retry={() => pops.mutate()}
      >
        <MutationForm
          submit="Gerar prévia da importação"
          onSubmit={async () => {
            if (!file) throw new Error("Selecione o arquivo KML.");
            if (/\.kmz$/i.test(file.name))
              throw new Error(
                "Arquivos KMZ não são aceitos; extraia o .kml e envie-o.",
              );
            if (file.size > maxUploadBytes)
              throw new Error("O arquivo deve ter até 5 MB.");
            const request: ImportRequest = {
              pop_id: values.pop_id,
              file_name: file.name,
              content_base64: await fileToBase64(file),
              box_kind: values.box_kind,
              box_ports: Number(values.box_ports),
              cable_kind: values.cable_kind,
              cable_fibers: Number(values.cable_fibers),
            };
            const result = kmlPreviewSchema.parse(
              await api("/ftth/gis/kml/preview", { body: request }),
            );
            setDone(null);
            setPreview({ request, result });
          }}
        >
          <div className="erp-columns">
            <FormField label="POP de destino da importação">
              <select
                className="commercial-select"
                required
                value={values.pop_id}
                onChange={(e) => set("pop_id")(e.target.value)}
              >
                <option value="">Selecione</option>
                {(pops.data ?? [])
                  .filter((p) => p.active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </FormField>
            <FormField
              label="Tipo padrão das caixas"
              hint='Sobrescrito pelo dado "tipo" do marcador, se houver.'
            >
              <select
                className="commercial-select"
                value={values.box_kind}
                onChange={(e) => set("box_kind")(e.target.value)}
              >
                <option value="cto">CTO · terminação óptica</option>
                <option value="ceo">CEO · emenda óptica</option>
              </select>
            </FormField>
            <FormField
              label="Portas padrão das caixas"
              hint='Sobrescrito pelo dado "portas" do marcador.'
            >
              <Input
                type="number"
                min={1}
                max={144}
                required
                value={values.box_ports}
                onChange={(e) => set("box_ports")(e.target.value)}
              />
            </FormField>
            <FormField label="Tipo padrão dos cabos">
              <select
                className="commercial-select"
                value={values.cable_kind}
                onChange={(e) => set("cable_kind")(e.target.value)}
              >
                {cableKinds.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Fibras padrão dos cabos"
              hint='Sobrescrito pelo dado "fibras" do marcador.'
            >
              <Input
                type="number"
                min={1}
                max={288}
                required
                value={values.cable_fibers}
                onChange={(e) => set("cable_fibers")(e.target.value)}
              />
            </FormField>
            <FormField
              label="Arquivo KML do projeto"
              hint="Somente .kml em UTF-8, até 5 MB; KMZ e DTD são recusados."
            >
              <Input
                type="file"
                accept=".kml,application/vnd.google-earth.kml+xml"
                onChange={(e) => {
                  setFile(e.currentTarget.files?.[0] ?? null);
                  setPreview(null);
                }}
              />
            </FormField>
          </div>
        </MutationForm>
      </QueryBoundary>
      {done && (
        <p role="status" className="profile-footnote">
          {done}
        </p>
      )}
      {preview && (
        <section aria-label="Prévia da importação KML" className="erp-stack">
          <div className="erp-inline-actions">
            <Badge variant="secondary">
              {preview.result.boxes.length} caixa(s)
            </Badge>
            <Badge variant="secondary">
              {preview.result.cables.length} cabo(s)
            </Badge>
            <Badge variant={errorCount ? "destructive" : "outline"}>
              {errorCount} item(ns) com erro
            </Badge>
            <Badge variant="outline">
              {preview.result.ignored.length} ignorado(s)
            </Badge>
          </div>
          {preview.result.boxes.length > 0 && (
            <Table aria-label="Caixas candidatas">
              <TableHeader>
                <TableRow>
                  {[
                    "Marcador",
                    "Caixa",
                    "Tipo",
                    "Portas",
                    "Coordenadas",
                    "Situação",
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.result.boxes.map((box) => (
                  <TableRow key={box.index}>
                    <TableCell>{box.index}</TableCell>
                    <TableCell>{box.name || "Sem nome"}</TableCell>
                    <TableCell>{box.kind.toUpperCase()}</TableCell>
                    <TableCell>{box.ports}</TableCell>
                    <TableCell>
                      {box.latitude != null && box.longitude != null
                        ? `${box.latitude}, ${box.longitude}`
                        : "—"}
                    </TableCell>
                    <TableCell>{situation(box.errors)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {preview.result.cables.length > 0 && (
            <Table aria-label="Cabos candidatos">
              <TableHeader>
                <TableRow>
                  {[
                    "Marcador",
                    "Cabo",
                    "Tipo",
                    "Fibras",
                    "Pontos",
                    "Comprimento",
                    "Pontas",
                    "Situação",
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.result.cables.map((cable) => (
                  <TableRow key={cable.index}>
                    <TableCell>{cable.index}</TableCell>
                    <TableCell>{cable.name || "Sem nome"}</TableCell>
                    <TableCell>{cableKindLabel(cable.kind)}</TableCell>
                    <TableCell>{cable.fiber_count}</TableCell>
                    <TableCell>{cable.points}</TableCell>
                    <TableCell>
                      {formatMeters(cable.computed_length_m)}
                    </TableCell>
                    <TableCell>
                      {cable.a_box_name ?? "Sem caixa"} →{" "}
                      {cable.b_box_name ?? "Sem caixa"}
                    </TableCell>
                    <TableCell>{situation(cable.errors)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {preview.result.ignored.length > 0 && (
            <p className="profile-footnote">
              Ignorados:{" "}
              {preview.result.ignored
                .map(
                  (item) =>
                    `${item.index} ${item.name || "sem nome"} (${item.reason})`,
                )
                .join("; ")}
              .
            </p>
          )}
          <p className="profile-footnote">
            Pontas: caixa importada a até 10 m da primeira ou da última
            coordenada do cabo. Itens com erro impedem a aplicação; corrija o
            arquivo e gere nova prévia.
          </p>
          <div className="erp-inline-actions">
            <ActionButton
              disabled={!preview.result.valid}
              confirm={`Importar ${preview.result.boxes.length} caixa(s) e ${preview.result.cables.length} cabo(s) de ${preview.request.file_name}? Nada é gravado se algum item falhar.`}
              onClick={async () => {
                const applied = kmlApplySchema.parse(
                  await api("/ftth/gis/kml/apply", { body: preview.request }),
                );
                const message = `Importação concluída: ${applied.boxes_created} caixa(s) e ${applied.cables_created} cabo(s) gravados.`;
                setPreview(null);
                setDone(message);
                toast.success(message);
                await mutate(
                  (key) =>
                    key === "erp-ftth-boxes" ||
                    key === "erp-ftth-box-options" ||
                    (Array.isArray(key) &&
                      ["erp-ftth-cables", "erp-map", "erp-map-cables"].includes(
                        key[0],
                      )),
                );
              }}
            >
              Aplicar importação
            </ActionButton>
          </div>
        </section>
      )}
    </Panel>
  );
}
