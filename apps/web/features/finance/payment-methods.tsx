import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/features/shared/action";
import { FormField } from "@/features/shared/form";

export function safeBoletoLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      [
        "visualizacao.gerencianet.com.br",
        "visualizacao.efipay.com.br",
      ].includes(u.hostname)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function PaymentMethods({
  methods,
  demo,
}: {
  methods: Record<string, unknown>;
  demo: boolean;
}) {
  const copy =
    typeof methods.pix_copy_paste === "string" ? methods.pix_copy_paste : null;
  const qr =
    typeof methods.pix_qr_code === "string" &&
    methods.pix_qr_code.length <= 350000 &&
    /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(
      methods.pix_qr_code,
    )
      ? methods.pix_qr_code
      : null;
  const barcode =
    typeof methods.boleto_barcode === "string" ? methods.boleto_barcode : null;
  const link = safeBoletoLink(methods.boleto_url);
  return (
    <ProfileSection title="Meios de pagamento">
      {demo && (
        <Badge variant="warning">Simulado · sem movimentação de dinheiro</Badge>
      )}
      <div className="erp-stack">
        {copy && (
          <FormField label="Pix copia e cola">
            <Input readOnly value={copy} />
            <ActionButton
              onClick={async () => navigator.clipboard.writeText(copy)}
            >
              Copiar Pix
            </ActionButton>
          </FormField>
        )}
        {copy && qr && (
          <img
            src={qr}
            alt="QR Code Pix retornado pelo provedor"
            width={192}
            height={192}
            className="max-w-full rounded-md border"
          />
        )}
        {barcode && (
          <FormField label="Linha digitável do boleto">
            <Input readOnly value={barcode} />
            <ActionButton
              onClick={async () => navigator.clipboard.writeText(barcode)}
            >
              Copiar linha digitável
            </ActionButton>
          </FormField>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            Abrir boleto no provedor
          </a>
        )}
        {!copy && !barcode && !link && (
          <p role="status">
            Artefatos de pagamento ainda não disponíveis. Consulte a cobrança
            novamente.
          </p>
        )}
        {demo && !link && typeof methods.boleto_url === "string" && (
          <ProfileFacts
            items={[["Endereço demonstrativo do boleto", methods.boleto_url]]}
          />
        )}
      </div>
    </ProfileSection>
  );
}
