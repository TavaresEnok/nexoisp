import useSWR from "swr";
import { api, erpClient } from "@/platform/erp-client";
import { signatureStateSchema, visitsSchema } from "./field-model";

const orderPath = (id: string) => `/work-orders/${encodeURIComponent(id)}`;

export function useWorkVisits(id: string) {
  return useSWR(["erp-work-visits", id], ([, id]) =>
    api<unknown>(`${orderPath(id)}/visits`).then((data) =>
      visitsSchema.parse(data),
    ),
  );
}

export function useWorkSignature(id: string) {
  return useSWR(["erp-work-signature", id], ([, id]) =>
    api<unknown>(`${orderPath(id)}/signature`).then((data) =>
      signatureStateSchema.parse(data),
    ),
  );
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("Não foi possível ler a imagem da assinatura."));
    reader.readAsDataURL(blob);
  });
}

/** Imagem privada da assinatura como data URL: serve à ficha e à impressão sem URL pública. */
export function useSignatureImage(id: string, documentId: string | undefined) {
  return useSWR(
    documentId ? ["erp-work-signature-image", id, documentId] : null,
    async ([, id]) => {
      const { blob } = await erpClient.download(
        `${orderPath(id)}/signature/image`,
      );
      if (blob.type !== "image/png")
        throw new Error("Imagem da assinatura em formato inesperado.");
      return dataUrl(blob);
    },
  );
}
