import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// Chaves vêm do ambiente. Fora de produção, ausentes => efêmeras (somente dev/teste).
const prod = process.env.NODE_ENV === 'production';
function fromEnv(name: string): string | undefined {
  const v = process.env[name];
  if (!v && prod && process.env.NEXO_DEMO_MODE !== '1') throw new Error(`${name} é obrigatória em produção`);
  return v;
}

let signingKey: KeyObject | undefined;
function getSigningKey(): KeyObject {
  if (signingKey) return signingKey;
  const b64 = fromEnv('NEXO_OP_SIGNING_KEY');
  signingKey = b64
    ? createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' })
    : generateKeyPairSync('ed25519').privateKey;
  return signingKey;
}
/** Assinatura Ed25519 (node:crypto) sobre os bytes exatos do envelope persistido (ADR-007). */
export function signEnvelope(envelope: string): string {
  return sign(null, Buffer.from(envelope, 'utf8'), getSigningKey()).toString('base64');
}
/** Chave pública (raw, base64) entregue ao agente no cadastro. */
export function signingPublicKey(): string {
  const der = createPublicKey(getSigningKey()).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

let secretKeys: Buffer[] | undefined;
/** [atual, anteriores...]. NEXO_SECRET_KEY_PREVIOUS (uma ou mais, separadas por vírgula) só decifra, durante a rotação. */
function getSecretKeys(): Buffer[] {
  if (secretKeys) return secretKeys;
  const cur = fromEnv('NEXO_SECRET_KEY');
  const list = [cur ? Buffer.from(cur, 'base64') : randomBytes(32),
    ...(process.env.NEXO_SECRET_KEY_PREVIOUS ?? '').split(',').map((k) => k.trim()).filter(Boolean).map((k) => Buffer.from(k, 'base64'))];
  if (list.some((k) => k.length !== 32)) throw new Error('NEXO_SECRET_KEY(_PREVIOUS) deve ter 32 bytes (base64)');
  return (secretKeys = list);
}
export function resetKeyCache() { secretKeys = undefined; }

/** Cifra segredos PPPoE/MFA em repouso (AES-256-GCM). O RADIUS precisa do segredo recuperável (CHAP). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getSecretKeys()[0], iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
function tryDecrypt(key: Buffer, iv: string, tag: string, enc: string): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // tag GCM não confere: chave errada ou dado adulterado
  }
}
export function decryptSecret(stored: string): string {
  const [v, iv, tag, enc] = stored.split('.');
  if (v !== 'v1') throw new Error('formato de segredo desconhecido');
  for (const k of getSecretKeys()) {
    const r = tryDecrypt(k, iv, tag, enc);
    if (r !== null) return r;
  }
  throw new Error('segredo não pôde ser decifrado com as chaves configuradas');
}
/** true se o valor NÃO está cifrado com a chave atual (precisa ser recifrado na rotação). */
export function needsRotation(stored: string): boolean {
  const [, iv, tag, enc] = stored.split('.');
  return tryDecrypt(getSecretKeys()[0], iv, tag, enc) === null;
}
