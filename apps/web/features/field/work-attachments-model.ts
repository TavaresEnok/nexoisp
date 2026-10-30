import { z } from "zod";

export const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  kind: z.enum(["photo", "other"]),
  mime: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
  size_bytes: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * 1024),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  created_at: z.string().datetime({ offset: true }),
});

export const attachmentsSchema = z.object({
  items: z.array(attachmentSchema),
  can_upload: z.boolean(),
  can_delete: z.boolean(),
});

export const attachmentAccept =
  "application/pdf,image/jpeg,image/png,image/webp";
export function attachmentActions(
  status: string,
  writable: boolean,
  permissions?: { can_upload: boolean; can_delete: boolean },
) {
  const open = status !== "done" && status !== "canceled";
  return {
    upload: open && writable && permissions?.can_upload === true,
    delete: open && writable && permissions?.can_delete === true,
  };
}
const allowedMime = new Set(attachmentAccept.split(","));
export function validateAttachment(file: File): string | null {
  if (!file.name.trim() || Array.from(file.name).length > 120)
    return "O nome do arquivo deve ter de 1 a 120 caracteres.";
  if (!allowedMime.has(file.type))
    return "Selecione um PDF ou uma imagem JPEG, PNG ou WebP.";
  if (file.size < 1 || file.size > 5 * 1024 * 1024)
    return "O arquivo deve ter entre 1 byte e 5 MiB.";
  return null;
}
