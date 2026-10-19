import { z } from "zod";
export const searchSchema = z.object({
  q: z.string(),
  results: z.array(
    z.object({
      subscriber_id: z.string().uuid(),
      subscriber_name: z.string(),
      document: z.string().nullable(),
      contract_id: z.string().uuid().nullable(),
      plan_name: z.string().nullable(),
      contract_status: z.string().nullable(),
      pppoe_username: z.string().nullable(),
      desired_policy: z.string().nullable(),
      online: z.boolean().nullable(),
      ip: z.string().nullable(),
      overdue: z.coerce.number().nullable(),
      matched: z.array(z.string()),
    }),
  ),
});
