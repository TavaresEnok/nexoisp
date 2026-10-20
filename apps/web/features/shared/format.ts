/** Formatação de documentos e telefones brasileiros para exibição; o valor armazenado não muda. */
export function formatDocument(value?: string | null) {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 11)
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (digits.length === 14)
    return digits.replace(
      /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
      "$1.$2.$3/$4-$5",
    );
  return value || "";
}
export function formatPhone(value?: string | null) {
  const raw = value ?? "";
  const digits = raw.replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (digits.length === 11)
    return digits.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  if (digits.length === 10)
    return digits.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  return raw;
}
/** Código curto e legível de um registro identificado por UUID. */
export function shortCode(id: string) {
  return id.slice(0, 8).toUpperCase();
}
