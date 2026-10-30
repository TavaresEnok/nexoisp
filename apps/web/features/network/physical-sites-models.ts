import { z } from "zod";

export const physicalSiteSchema = z.object({
  id: z.string().uuid(),
  pop_id: z.string().uuid(),
  pop_name: z.string(),
  kind: z.enum(["pole", "tower", "building"]),
  name: z.string(),
  city: z.string().nullable(),
  address: z.string().nullable(),
  latitude: z.number().finite().nullable(),
  longitude: z.number().finite().nullable(),
  notes: z.string(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const physicalSitesPageSchema = z.object({
  items: z.array(physicalSiteSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type PhysicalSite = z.infer<typeof physicalSiteSchema>;
export type SitePop = { id: string; name: string; active: boolean };
export const siteKinds = [
  { value: "pole", label: "Poste" },
  { value: "tower", label: "Torre" },
  { value: "building", label: "Condomínio" },
];
