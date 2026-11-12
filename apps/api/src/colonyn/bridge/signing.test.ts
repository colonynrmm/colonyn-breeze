import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalString, sign, verifyBreezeHookSignature, verifySignature } from './signing';

const secret = 'hmac_0123456789abcdef0123456789abcdef';
const now = 1_800_000_000;

describe('colonyn bridge signing', () => {
  it('builds the canonical string Odoo reproduces in Python', () => {
    expect(canonicalString('1800000000', 'post', '/v1/tenants', '{"a":1}')).toBe('1800000000\nPOST\n/v1/tenants\n{"a":1}');
  });

  it('accepts a correctly signed request', () => {
    const signature = sign(secret, String(now), 'POST', '/v1/tenants', '{}');
    expect(verifySignature({ secret, timestamp: String(now), signature, method: 'POST', path: '/v1/tenants', body: '{}', maxSkewSeconds: 300, nowSeconds: now }))
      .toEqual({ ok: true });
  });

  it('rejects a tampered body, path or method', () => {
    const signature = sign(secret, String(now), 'POST', '/v1/tenants', '{}');
    const base = { secret, timestamp: String(now), signature, maxSkewSeconds: 300, nowSeconds: now };
    expect(verifySignature({ ...base, method: 'POST', path: '/v1/tenants', body: '{"x":1}' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySignature({ ...base, method: 'POST', path: '/v1/tenants/x', body: '{}' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySignature({ ...base, method: 'PATCH', path: '/v1/tenants', body: '{}' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects stale, malformed and missing timestamps', () => {
    const old = String(now - 301);
    const signature = sign(secret, old, 'GET', '/v1/tenants/a', '');
    expect(verifySignature({ secret, timestamp: old, signature, method: 'GET', path: '/v1/tenants/a', body: '', maxSkewSeconds: 300, nowSeconds: now }))
      .toEqual({ ok: false, reason: 'stale' });
    expect(verifySignature({ secret, timestamp: 'abc', signature, method: 'GET', path: '/', body: '', maxSkewSeconds: 300, nowSeconds: now }))
      .toEqual({ ok: false, reason: 'bad_timestamp' });
    expect(verifySignature({ secret, timestamp: undefined, signature, method: 'GET', path: '/', body: '', maxSkewSeconds: 300, nowSeconds: now }))
      .toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('verifies Breeze partner-hook signatures', () => {
    const body = '{"event":"device-limit","partnerId":"p"}';
    const header = `sha256=${createHmac('sha256', 'hooks').update(body).digest('hex')}`;
    expect(verifyBreezeHookSignature('hooks', body, header)).toBe(true);
    expect(verifyBreezeHookSignature('hooks', `${body} `, header)).toBe(false);
    expect(verifyBreezeHookSignature('hooks', body, undefined)).toBe(false);
  });
});
