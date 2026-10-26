/** Persist before sending; an ambiguous response must never discard the intent. */
export type PaymentIntent = {
  intent_id: string;
  body: Record<string, unknown>;
  form: Record<string, unknown>;
};
export function paymentIntentKey(
  tenant: string,
  user: string,
  invoice: string,
) {
  return `nexo:manual-payment:v1:${tenant}:${user}:${invoice}`;
}
export function readPaymentIntent(
  storage: Storage,
  key: string,
): PaymentIntent | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as PaymentIntent;
  if (!value.intent_id || !value.body || !value.form)
    throw new Error(
      "Não foi possível recuperar a baixa pendente. Confira o recebimento antes de continuar.",
    );
  return value;
}
export async function sendPaymentIntent(
  storage: Storage,
  key: string,
  body: Record<string, unknown>,
  form: Record<string, unknown>,
  send: (body: Record<string, unknown>) => Promise<unknown>,
  newId: () => string = () => crypto.randomUUID(),
) {
  const intent = readPaymentIntent(storage, key) ?? {
    intent_id: newId(),
    body,
    form,
  };
  storage.setItem(key, JSON.stringify(intent)); // Failure to persist stops the request.
  try {
    await send({ ...intent.body, intent_id: intent.intent_id });
  } catch (error) {
    // Only definitive input rejection is safe to edit. 409/timeout/5xx stay pending.
    const status = (error as { status?: number })?.status;
    if (status === 400 || status === 422) storage.removeItem(key);
    throw error;
  }
  storage.removeItem(key); // If removal fails, replay remains safe on the server.
}
