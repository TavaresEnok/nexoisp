import useSWR from "swr";
import { api } from "@/platform/erp-client";
import { useSession } from "@/features/session/provider";
import {
  brandingKey,
  brandingLogoUrl,
  brandingSchema,
} from "./branding-models";

export function usePortalBranding() {
  const { me } = useSession();
  return useSWR(brandingKey(me), async () =>
    brandingSchema.parse(await api("/tenant-branding")),
  );
}

export function PortalBranding() {
  const { me } = useSession();
  const result = usePortalBranding();
  const brand = result.error ? undefined : result.data;
  const name = brand?.display_name ?? me?.tenant?.name ?? "o provedor";
  return (
    <div
      className="flex min-w-0 items-center gap-3"
      aria-label="Identidade do provedor"
    >
      {brand?.logo && (
        <img
          src={brandingLogoUrl(brand.logo.sha256)}
          alt={`Logotipo de ${name}`}
          className="h-12 w-24 shrink-0 object-contain"
        />
      )}
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{name}</span>
      {result.error && (
        <span className="text-muted-foreground">
          Identidade personalizada indisponível.
        </span>
      )}
    </div>
  );
}
