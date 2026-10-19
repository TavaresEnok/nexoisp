import { z } from "zod";
export const sessionSchema = z.object({
  id: z.string().min(1), name: z.string(), email: z.string(), role: z.enum(["saas_operator", "admin", "attendant", "finance", "noc", "subscriber"]),
  perms: z.array(z.string()), modules: z.array(z.string()), support: z.boolean(), demo: z.boolean(), mfa_enabled: z.boolean(), mfa_pending: z.boolean(),
  tenant: z.object({ id: z.string().min(1), name: z.string(), slug: z.string() }).nullable(),
});
export type Session = z.infer<typeof sessionSchema>;
export const can = (me: Session | null, permission: string) => Boolean(me?.perms.includes(permission));
export const hasModule = (me: Session | null, module: string) => Boolean(me?.modules.includes(module));
export const sessionScope = (me: Session) => [me.id, me.tenant?.id ?? "platform", me.role, me.support, [...me.perms].sort().join(","), [...me.modules].sort().join(",")].join(":");
export const roleLabels: Record<Session["role"], string> = { saas_operator: "Operador do SaaS", admin: "Administrador", attendant: "Atendimento", finance: "Financeiro", noc: "Técnico/NOC", subscriber: "Assinante" };
