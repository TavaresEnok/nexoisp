import type {
  EditorField,
  EditorValues,
} from "@/features/shared/record-editor";
import { decimalToCents } from "@/features/contracts/models";
import { money, date } from "@/lib/format";
import {
  productLabels,
  type ProviderBillingData,
  type ProviderIntent,
  type BillingProduct,
} from "./provider-billing-model";

export const issueFields = (data: ProviderBillingData): EditorField[] => [
  {
    key: "choice",
    label: "Conta e produto Efí sandbox",
    type: "select",
    required: true,
    options: data.accounts.flatMap((a) =>
      a.products.map((p) => ({
        value: `${a.id}:${p}`,
        label: `${a.name} · ${productLabels[p]}`,
      })),
    ),
  },
  {
    key: "expiration",
    label: "Validade do Pix (segundos)",
    type: "number",
    min: 60,
    max: 86400,
    required: true,
    when: (v) => v.choice.endsWith(":pix_cob"),
  },
  {
    key: "valid_days",
    label: "Dias de validade após vencimento",
    type: "number",
    min: 0,
    max: 120,
    required: true,
    when: (v) => v.choice.endsWith(":pix_cobv"),
  },
  ...(
    [
      ["name", "Nome / razão social", 200],
      ["document", "CPF ou CNPJ numérico (somente dígitos)", 14],
      ["street", "Logradouro", 200],
      ["city", "Cidade", 100],
      ["state", "UF", 2],
      ["zip", "CEP (somente dígitos)", 8],
    ] as const
  ).map(
    ([key, label, maxLength]): EditorField => ({
      key,
      label,
      maxLength,
      required: true,
      when: (v) => !v.choice.endsWith(":pix_cob"),
    }),
  ),
  {
    key: "email",
    label: "E-mail do pagador",
    type: "email",
    maxLength: 254,
    required: true,
    when: (v) => v.choice.endsWith(":bolix"),
  },
  {
    key: "number",
    label: "Número do endereço",
    maxLength: 30,
    required: true,
    when: (v) => v.choice.endsWith(":bolix"),
  },
  {
    key: "neighborhood",
    label: "Bairro",
    maxLength: 100,
    required: true,
    when: (v) => v.choice.endsWith(":bolix"),
  },
];
export function issuanceBody(
  invoice: string,
  values: EditorValues,
  data: ProviderBillingData,
): Record<string, unknown> {
  const [connection, selected] = values.choice.split(":");
  const product = selected as BillingProduct;
  if (
    !data.accounts.find((a) => a.id === connection)?.products.includes(product)
  )
    throw new Error("Selecione um produto compatível com a conta.");
  let options: Record<string, unknown> = { product };
  if (product === "pix_cob") {
    const expiration = Number(values.expiration);
    if (!Number.isInteger(expiration) || expiration < 60 || expiration > 86400)
      throw new Error("Informe uma validade entre 60 e 86400 segundos.");
    options.expiration_seconds = expiration;
  } else {
    const document = values.document.trim();
    if (!/^\d{11}$|^\d{14}$/.test(document))
      throw new Error(
        "Informe CPF de 11 dígitos ou CNPJ numérico de 14 dígitos.",
      );
    const tax = document.length === 11 ? { cpf: document } : { cnpj: document };
    const state = values.state.trim().toUpperCase();
    if (product === "pix_cobv") {
      const valid = Number(values.valid_days);
      if (!Number.isInteger(valid) || valid < 0 || valid > 120)
        throw new Error("Informe de 0 a 120 dias após o vencimento.");
      options = {
        product,
        valid_days: valid,
        debtor: {
          nome: values.name.trim(),
          ...tax,
          logradouro: values.street.trim(),
          cidade: values.city.trim(),
          uf: state,
          cep: values.zip.trim(),
        },
      };
    } else {
      options.customer = {
        name: values.name.trim(),
        email: values.email.trim(),
        ...(document.length === 11
          ? tax
          : {
              juridical_person: {
                corporate_name: values.name.trim(),
                cnpj: document,
              },
            }),
        address: {
          street: values.street.trim(),
          number: values.number.trim(),
          neighborhood: values.neighborhood.trim(),
          city: values.city.trim(),
          state,
          zipcode: values.zip.trim(),
        },
      };
    }
  }
  return { invoice_id: invoice, options };
}
export const operationFields = (
  data: ProviderBillingData,
  refund: boolean,
): EditorField[] => [
  ...(refund
    ? [
        {
          key: "payment",
          label: "Recebimento Pix original",
          type: "select" as const,
          required: true,
          options: data.refund_payments
            .filter((p) => p.refundable_cents > 0)
            .map((p) => ({
              value: p.id,
              label: `${date(p.paid_at)} · disponível ${money(p.refundable_cents / 100)} · ${p.id.slice(0, 8)}`,
            })),
        },
        { key: "amount", label: "Valor a devolver (R$)", required: true },
      ]
    : []),
  {
    key: "reason",
    label: "Justificativa (10 a 500 caracteres)",
    type: "textarea",
    maxLength: 500,
    required: true,
  },
];
export function operationBody(
  values: EditorValues,
  refund: boolean,
  data: ProviderBillingData,
): ProviderIntent["body"] {
  const reason = values.reason.trim();
  if (reason.length < 10 || reason.length > 500)
    throw new Error("Informe uma justificativa de 10 a 500 caracteres.");
  if (!refund) return { kind: "cancel", reason };
  const amount = decimalToCents(values.amount);
  const payment = data.refund_payments.find((p) => p.id === values.payment);
  if (!payment || amount <= 0 || amount > payment.refundable_cents)
    throw new Error(
      "O valor deve ser positivo e respeitar o limite disponível do recebimento.",
    );
  return {
    kind: "refund",
    reason,
    payment_id: payment.id,
    amount_cents: amount,
  };
}
