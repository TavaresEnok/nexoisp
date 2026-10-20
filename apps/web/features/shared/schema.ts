import { z } from "zod";

const decimalText = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/, "Valor numérico inválido");

// Valores monetários vêm do servidor como número ou texto decimal.
// Diferente de z.coerce.number(), ausência ou nulo é erro, nunca R$ 0,00.
export function money<T extends z.ZodNumber>(base?: T) {
  return z
    .union([z.number(), decimalText.transform(Number)])
    .pipe(base ?? z.number().finite());
}

export const cents = () => money(z.number().int());
