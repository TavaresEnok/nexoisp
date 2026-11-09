import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import {
  ProfileFacts,
  ProfileSection,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { blobToBase64 } from "./image-reduce";
import { signatureSchema } from "./field-model";
import { useSignatureImage, useWorkSignature } from "./field-hooks";
import type { OrderDetail } from "./models";

const stamp = (value: string) => new Date(value).toLocaleString("pt-BR");
const canvasWidth = 600;
const canvasHeight = 220;

/** Área de assinatura por toque, caneta ou mouse (Pointer Events). */
function SignaturePad({
  onDrawn,
  canvas,
}: {
  onDrawn: (drawn: boolean) => void;
  canvas: React.RefObject<HTMLCanvasElement | null>;
}) {
  const drawing = useRef(false);
  const points = useRef(0);
  const reset = () => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.lineWidth = 2.5;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#111111";
    points.current = 0;
    onDrawn(false);
  };
  useEffect(reset, []);
  const position = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvasWidth) / rect.width,
      y: ((event.clientY - rect.top) * canvasHeight) / rect.height,
    };
  };
  const stop = () => {
    drawing.current = false;
  };
  return (
    <div className="erp-stack">
      <canvas
        ref={canvas}
        width={canvasWidth}
        height={canvasHeight}
        role="img"
        aria-label="Área de assinatura do cliente"
        className="block w-full touch-none rounded-md border border-border bg-white"
        onPointerDown={(event) => {
          const context = event.currentTarget.getContext("2d");
          if (!context) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drawing.current = true;
          const { x, y } = position(event);
          context.beginPath();
          context.moveTo(x, y);
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const context = event.currentTarget.getContext("2d");
          if (!context) return;
          const { x, y } = position(event);
          context.lineTo(x, y);
          context.stroke();
          points.current += 1;
          if (points.current === 4) onDrawn(true);
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={stop}
      />
      <div className="erp-inline-actions">
        <Button type="button" variant="outline" size="sm" onClick={reset}>
          Limpar assinatura
        </Button>
      </div>
    </div>
  );
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Não foi possível gerar a imagem da assinatura.")),
      "image/png",
    ),
  );
}

export function WorkSignature({ order }: { order: OrderDetail }) {
  const state = useWorkSignature(order.id);
  const signature = state.data?.signature ?? null;
  const image = useSignatureImage(order.id, signature?.document_id);
  const { mutate } = useSWRConfig();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [signer, setSigner] = useState({ name: "", document: "" });
  const closed = ["done", "canceled"].includes(order.status);
  return (
    <ProfileSection
      title="Assinatura do cliente"
      caption="Capturada na tela e guardada como documento privado da OS, com hash SHA-256 e horário do servidor."
    >
      <QueryBoundary
        loading={state.isLoading}
        error={state.data ? undefined : state.error}
        retry={() => state.mutate()}
      >
        {signature && (
          <div className="erp-stack">
            {image.data && (
              <img
                src={image.data}
                alt={`Assinatura de ${signature.signer_name}`}
                className="block w-full max-w-md rounded-md border border-border bg-white"
              />
            )}
            {image.error && (
              <p role="alert">
                Não foi possível exibir a imagem da assinatura.
              </p>
            )}
            <ProfileFacts
              items={[
                ["Assinado por", signature.signer_name],
                [
                  "Documento de quem assina",
                  signature.signer_document ?? "Não informado",
                ],
                ["Registrada no servidor", stamp(signature.signed_at)],
                [
                  "Horário do aparelho",
                  signature.device_at
                    ? stamp(signature.device_at)
                    : "Não informado",
                ],
                [
                  "Coletada por",
                  signature.signed_by_name ?? "Usuário removido",
                ],
                [
                  "SHA-256 do arquivo",
                  <code className="mono break-all" key="hash">
                    {signature.sha256}
                  </code>,
                ],
              ]}
            />
          </div>
        )}
        {!signature && !state.data?.can_sign && (
          <p className="profile-footnote">
            {closed
              ? "Nenhuma assinatura registrada; a OS encerrada não aceita nova assinatura."
              : "Nenhuma assinatura registrada."}
          </p>
        )}
        {!signature && state.data?.can_sign && !closed && (
          <MutationForm
            submit="Registrar assinatura"
            onSubmit={async () => {
              if (!canvas.current || !drawn)
                throw new Error(
                  "Colete a assinatura na área indicada antes de registrar.",
                );
              const blob = await canvasPng(canvas.current);
              const saved = signatureSchema.parse(
                await api<unknown>(
                  `/work-orders/${encodeURIComponent(order.id)}/signature`,
                  {
                    body: {
                      signer_name: signer.name,
                      signer_document: signer.document.trim() || null,
                      content_base64: await blobToBase64(blob),
                      device_at: new Date().toISOString(),
                    },
                  },
                ),
              );
              toast.success("Assinatura registrada.");
              await state.mutate({ signature: saved, can_sign: false });
              await mutate(["erp-order", order.id]);
            }}
          >
            <div className="erp-stack">
              <SignaturePad canvas={canvas} onDrawn={setDrawn} />
              <FormField label="Nome de quem assina">
                <Input
                  required
                  minLength={2}
                  maxLength={120}
                  value={signer.name}
                  onChange={(event) =>
                    setSigner({ ...signer, name: event.target.value })
                  }
                />
              </FormField>
              <FormField
                label="Documento de quem assina (opcional)"
                hint="CPF, RG ou outro documento, de 3 a 30 caracteres."
              >
                <Input
                  maxLength={30}
                  value={signer.document}
                  onChange={(event) =>
                    setSigner({ ...signer, document: event.target.value })
                  }
                />
              </FormField>
            </div>
          </MutationForm>
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}
