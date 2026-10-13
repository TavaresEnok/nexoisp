import { z } from 'zod';

export const onlyDigits = (s: string) => s.replace(/\D/g, '');

export function validCpf(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
export function validCnpj(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (n: number) => {
    const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = w.reduce((a, x, i) => a + x * Number(d[i]), 0) % 11;
    return s < 2 ? 0 : 11 - s;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
export const validDocument = (d: string) => validCpf(d) || validCnpj(d);

const optText = (max = 200) =>
  z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const zDocument = z.string().nullish()
  .transform((v) => (v ? onlyDigits(v) : null))
  .refine((v) => v === null || validDocument(v), 'CPF/CNPJ inválido');

export const zSubscriber = z.object({
  name: z.string().trim().min(2, 'nome obrigatório').max(200),
  document: zDocument,
  email: z.string().trim().email('e-mail inválido').max(200).nullish().or(z.literal('')).transform((v) => v || null),
  phone: optText(40),
  address_street: optText(), address_number: optText(20), address_district: optText(),
  address_city: optText(), address_state: optText(2), address_zip: optText(12),
  notes: optText(2000),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data de nascimento inválida').nullish().or(z.literal('')).transform((v) => v || null),
  rg: z.string().trim().regex(/^[0-9A-Za-z.\- /]{3,20}$/, 'RG inválido').nullish().or(z.literal('')).transform((v) => v || null),
  rg_issuer: optText(20), mother_name: optText(200), trade_name: optText(200),
  status: z.enum(['active', 'inactive']).default('active'),
});
export const zUuid = z.string().uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data inválida');
export const zPage = { limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() };
