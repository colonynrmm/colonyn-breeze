import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request signing shared by Odoo -> Bridge calls and Bridge -> Odoo events.
 *
 *   X-Colonyn-Timestamp: <unix seconds>
 *   X-Colonyn-Signature: sha256=<hex HMAC-SHA256(secret, canonical)>
 *
 *   canonical = timestamp + "\n" + METHOD + "\n" + path(+query) + "\n" + raw body
 *
 * The same string is easy to rebuild in Python (Odoo):
 *   hmac.new(secret, f"{ts}\n{method}\n{path}\n{body}".encode(), sha256).hexdigest()
 */

export const TIMESTAMP_HEADER = 'x-colonyn-timestamp';
export const SIGNATURE_HEADER = 'x-colonyn-signature';

export function canonicalString(timestamp: string, method: string, path: string, body: string): string {
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;
}

export function sign(secret: string, timestamp: string, method: string, path: string, body: string): string {
  const digest = createHmac('sha256', secret)
    .update(canonicalString(timestamp, method, path, body))
    .digest('hex');
  return `sha256=${digest}`;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type VerifyFailure = 'missing_headers' | 'bad_timestamp' | 'stale' | 'bad_signature';

export function verifySignature(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  method: string;
  path: string;
  body: string;
  maxSkewSeconds: number;
  nowSeconds?: number;
}): { ok: true } | { ok: false; reason: VerifyFailure } {
  const { timestamp, signature } = input;
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > input.maxSkewSeconds) return { ok: false, reason: 'stale' };

  const expected = sign(input.secret, timestamp, input.method, input.path, input.body);
  if (!safeEqual(expected, signature.trim())) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/** Breeze partner hooks: `X-Breeze-Signature: sha256=<hex HMAC(secret, body)>`. */
export function verifyBreezeHookSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return safeEqual(expected, header.trim());
}
