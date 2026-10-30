import { z } from "zod";
import { sessionScope, type Session } from "@/features/session/model";

export const brandingSchema = z.object({
  display_name: z.string().nullable(),
  logo: z
    .object({
      mime: z.literal("image/png"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size_bytes: z.number().int(),
      width: z.number().int(),
      height: z.number().int(),
    })
    .nullable(),
  updated_at: z.string().nullable(),
});
export type PortalBranding = z.infer<typeof brandingSchema>;
export type BrandingUpdate = { display_name: string | null } & (
  | { logo_action: "keep" | "remove" }
  | { logo_action: "replace"; logo_content_base64: string }
);
export const brandingKey = (me: Session | null) =>
  me?.tenant && !me.mfa_pending
    ? (["tenant-branding", sessionScope(me), me.tenant.id, me.id] as const)
    : null;
export const brandingLogoUrl = (hash: string) =>
  `/api/tenant-branding/logo?v=${encodeURIComponent(hash)}`;
