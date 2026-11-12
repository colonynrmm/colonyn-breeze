import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { BridgeConfig } from './config';
import { COLONYN_FEATURES } from '../entitlements/features';
import { notifyOdoo } from './odooNotify';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, safeEqual, verifyBreezeHookSignature, verifySignature } from './signing';
import {
  BridgeError,
  PLANS,
  getTenant,
  provisionTenant,
  recordHook,
  resendInvite,
  setStatus,
  subscriptionRefForPartner,
  updatePlan,
} from './tenants';

const MAX_BODY_BYTES = 64 * 1024;

// Used in URL paths, so no slashes: Odoo sends e.g. "odoo-sub-42" (its record id).
const refSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits and . _ - only');
const limitSchema = z.number().int().min(0).max(1_000_000).nullable();

const quotaSchema = z.object({
  plan: z.enum(PLANS),
  max_organizations: limitSchema,
  max_devices: limitSchema,
  // Plan modules; omitted by older Odoo versions, in which case they are left as they are.
  features: z.array(z.enum(COLONYN_FEATURES)).max(COLONYN_FEATURES.length).optional(),
  // Technician seats (null = unlimited); only applied together with `features`.
  max_technicians: z.number().int().min(1).max(100_000).nullable().optional(),
});

const provisionSchema = quotaSchema.extend({
  subscription_ref: refSchema,
  company_name: z.string().trim().min(2).max(200),
  admin_name: z.string().trim().min(1).max(200),
  admin_email: z.string().trim().max(254).email(),
});

const reasonSchema = z.object({ reason: z.string().trim().max(500).optional() }).default({});

const inviteSchema = z
  .object({
    admin_email: z.string().trim().max(254).email().optional(),
    admin_name: z.string().trim().min(1).max(200).optional(),
  })
  .default({});

type Vars = { rawBody: string };

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function parseJson<T>(schema: z.ZodType<T>, raw: string): T {
  let value: unknown = {};
  if (raw.trim() !== '') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BridgeError(400, 'INVALID_JSON', 'Body is not valid JSON');
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new BridgeError(422, 'VALIDATION_FAILED', 'Request body failed validation'), {
      details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

function refParam(c: Context): string {
  const parsed = refSchema.safeParse(decodeURIComponent(c.req.param('ref') ?? ''));
  if (!parsed.success) throw new BridgeError(400, 'INVALID_REF', 'Invalid subscription reference');
  return parsed.data;
}

export function createBridgeApp(config: BridgeConfig) {
  const app = new Hono<{ Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof BridgeError) {
      return c.json(errorBody(err.code, err.message, (err as { details?: unknown }).details), err.status);
    }
    console.error('[colonyn-bridge] unhandled error:', err);
    return c.json(errorBody('INTERNAL', 'Internal error'), 500);
  });

  app.get('/health', (c) => c.json({ ok: true, service: 'colonyn-bridge' }));

  // ---- Breeze partner hooks (PARTNER_HOOKS_URL=http://colonyn-bridge:3010/hooks)
  app.post('/hooks/:event', async (c) => {
    const raw = await c.req.text();
    if (config.partnerHooksSecret && !verifyBreezeHookSignature(config.partnerHooksSecret, raw, c.req.header('x-breeze-signature'))) {
      return c.json(errorBody('BAD_SIGNATURE', 'Invalid hook signature'), 401);
    }
    let payload: { event?: string; partnerId?: string; data?: Record<string, unknown> } = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json(errorBody('INVALID_JSON', 'Body is not valid JSON'), 400);
    }
    const event = c.req.param('event');
    const partnerId = payload.partnerId;
    if (!partnerId) return c.json({});

    const subscriptionRef = await subscriptionRefForPartner(partnerId).catch(() => null);
    await recordHook(partnerId, subscriptionRef, event, payload.data ?? {}).catch(() => undefined);
    void notifyOdoo(config, `breeze.${event}`, { subscription_ref: subscriptionRef, partner_id: partnerId, data: payload.data ?? {} });

    if (event === 'device-limit' && config.upgradeUrl) {
      return c.json({ upgradeUrl: config.upgradeUrl, message: 'Kuota device paket Anda sudah penuh. Tambah device atau upgrade paket di colonyn.com.' });
    }
    // Registration is disabled on this instance; nothing else needs a reply.
    return c.json({});
  });

  // ---- Odoo API: bearer token + HMAC signature on every call
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || !safeEqual(token, config.apiToken)) {
      return c.json(errorBody('UNAUTHORIZED', 'Missing or invalid bearer token'), 401);
    }

    const length = Number(c.req.header('content-length') ?? '0');
    if (length > MAX_BODY_BYTES) return c.json(errorBody('BODY_TOO_LARGE', 'Body too large'), 413);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json(errorBody('BODY_TOO_LARGE', 'Body too large'), 413);

    const url = new URL(c.req.url);
    const verdict = verifySignature({
      secret: config.hmacSecret,
      timestamp: c.req.header(TIMESTAMP_HEADER),
      signature: c.req.header(SIGNATURE_HEADER),
      method: c.req.method,
      path: url.pathname + url.search,
      body: raw,
      maxSkewSeconds: config.maxSkewSeconds,
    });
    if (!verdict.ok) {
      return c.json(errorBody('BAD_SIGNATURE', `Signature check failed: ${verdict.reason}`), 401);
    }
    c.set('rawBody', raw);
    await next();
  });

  app.post('/v1/tenants', async (c) => {
    const body = parseJson(provisionSchema, c.get('rawBody'));
    const result = await provisionTenant(config, {
      subscriptionRef: body.subscription_ref,
      companyName: body.company_name,
      adminName: body.admin_name,
      adminEmail: body.admin_email,
      plan: body.plan,
      maxOrganizations: body.max_organizations,
      maxDevices: body.max_devices,
      features: body.features ? [...new Set(body.features)] : undefined,
      maxTechnicians: body.max_technicians,
    });
    return c.json(result, result.created ? 201 : 200);
  });

  app.get('/v1/tenants/:ref', async (c) => c.json({ tenant: await getTenant(config, refParam(c)) }));

  app.patch('/v1/tenants/:ref/plan', async (c) => {
    const body = parseJson(quotaSchema, c.get('rawBody'));
    const tenant = await updatePlan(config, refParam(c), {
      plan: body.plan,
      maxOrganizations: body.max_organizations,
      maxDevices: body.max_devices,
      features: body.features ? [...new Set(body.features)] : undefined,
      maxTechnicians: body.max_technicians,
    });
    return c.json({ tenant });
  });

  app.post('/v1/tenants/:ref/suspend', async (c) => {
    const { reason } = parseJson(reasonSchema, c.get('rawBody'));
    return c.json(await setStatus(config, refParam(c), 'suspended', reason));
  });

  app.post('/v1/tenants/:ref/reactivate', async (c) => {
    const { reason } = parseJson(reasonSchema, c.get('rawBody'));
    return c.json(await setStatus(config, refParam(c), 'active', reason));
  });

  app.post('/v1/tenants/:ref/cancel', async (c) => {
    const { reason } = parseJson(reasonSchema, c.get('rawBody'));
    return c.json(await setStatus(config, refParam(c), 'offboarding', reason));
  });

  app.post('/v1/tenants/:ref/invite', async (c) => {
    const body = parseJson(inviteSchema, c.get('rawBody'));
    return c.json(await resendInvite(config, refParam(c), { adminEmail: body.admin_email, adminName: body.admin_name }));
  });

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'Route not found'), 404));

  return app;
}
