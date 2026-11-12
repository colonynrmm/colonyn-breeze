import type { Context, MiddlewareHandler } from 'hono';
import { featureForPath, toApiRelativePath } from './featureMap';
import { FEATURE_LABELS, type ColonynFeature } from './features';
import { countTechnicians, entitlementsEnforced, getEntitlements, holdsSeat, partnerIdForOrg } from './store';

export interface Denial {
  status: 403 | 503;
  body: Record<string, unknown>;
}

function upgradeUrl(): string | null {
  return process.env.COLONYN_UPGRADE_URL?.trim() || null;
}

export function featureDenial(feature: ColonynFeature): Denial {
  return {
    status: 403,
    body: {
      error: `${FEATURE_LABELS[feature]} is not included in your Colonyn plan.`,
      code: 'FEATURE_NOT_IN_PLAN',
      feature,
      upgradeUrl: upgradeUrl(),
    },
  };
}

const UNAVAILABLE: Denial = {
  status: 503,
  body: { error: 'Plan check temporarily unavailable. Try again in a moment.', code: 'ENTITLEMENT_UNAVAILABLE' },
};

/**
 * The single decision used by every entry point: given a request path and the
 * partner it acts for, deny when the path belongs to a module the plan does not
 * include. `bypass` is for platform administrators (system scope).
 */
export async function entitlementDenial(input: {
  path: string;
  partnerId: string | null | undefined;
  bypass?: boolean;
}): Promise<Denial | null> {
  if (input.bypass || !input.partnerId || !entitlementsEnforced()) return null;
  const feature = featureForPath(toApiRelativePath(input.path));
  if (!feature) return null;
  let features;
  try {
    ({ features } = await getEntitlements(input.partnerId));
  } catch (err) {
    console.error('[colonyn] entitlement lookup failed; denying gated module:', err instanceof Error ? err.message : err);
    return UNAVAILABLE;
  }
  if (features === null || features.has(feature)) return null;
  return featureDenial(feature);
}

/**
 * Seat check before a NEW staff membership is created. An e-mail that already
 * holds a seat in the partner (re-invite, role change) never counts twice.
 */
export async function technicianLimitDenial(input: {
  partnerId: string | null | undefined;
  email?: string | null;
  bypass?: boolean;
}): Promise<Denial | null> {
  if (input.bypass || !input.partnerId || !entitlementsEnforced()) return null;
  try {
    const { maxTechnicians } = await getEntitlements(input.partnerId);
    if (maxTechnicians === null) return null;
    if (input.email && (await holdsSeat(input.partnerId, input.email))) return null;
    const used = await countTechnicians(input.partnerId);
    if (used < maxTechnicians) return null;
    return {
      status: 403,
      body: {
        error: `Your Colonyn plan allows ${maxTechnicians} technician${maxTechnicians === 1 ? '' : 's'} and all of them are in use. Remove a user or add technicians to your plan.`,
        code: 'TECHNICIAN_LIMIT',
        limit: maxTechnicians,
        used,
        upgradeUrl: upgradeUrl(),
      },
    };
  } catch (err) {
    console.error('[colonyn] technician limit lookup failed:', err instanceof Error ? err.message : err);
    return UNAVAILABLE;
  }
}

/**
 * Hono middleware for surfaces that authenticate outside authMiddleware
 * (client portal, Partner API, MCP). `resolvePartner` reads whatever the
 * preceding auth middleware stored; when no partner can be resolved the
 * request passes (core data stays behind its own auth either way).
 */
export function entitlementMiddleware(resolvePartner: (c: Context) => Promise<string | null> | string | null): MiddlewareHandler {
  return async (c, next) => {
    if (!entitlementsEnforced()) return next();
    let partnerId: string | null = null;
    try {
      partnerId = await resolvePartner(c);
    } catch (err) {
      console.error('[colonyn] could not resolve partner for entitlement check:', err instanceof Error ? err.message : err);
      return c.json(UNAVAILABLE.body, UNAVAILABLE.status);
    }
    const denial = await entitlementDenial({ path: c.req.path, partnerId });
    if (denial) return c.json(denial.body, denial.status);
    await next();
  };
}

/** Client portal: the session belongs to one organization. */
export const portalEntitlementMiddleware = entitlementMiddleware(async (c) => {
  const auth = c.get('portalAuth' as never) as { user?: { orgId?: string | null } } | undefined;
  return partnerIdForOrg(auth?.user?.orgId ?? null);
});

/** Partner API (service-principal keys). */
export const partnerApiEntitlementMiddleware = entitlementMiddleware((c) => {
  const principal = c.get('partnerApiPrincipal' as never) as { partnerId?: string | null } | undefined;
  return principal?.partnerId ?? null;
});

/** MCP: API key, service principal or OAuth bearer. */
export const mcpEntitlementMiddleware = entitlementMiddleware(async (c) => {
  const key = c.get('apiKey' as never) as { partnerId?: string | null; orgId?: string | null } | undefined;
  if (key?.partnerId) return key.partnerId;
  const orgId = key?.orgId ?? (c.get('apiKeyOrgId' as never) as string | null | undefined) ?? null;
  return partnerIdForOrg(orgId);
});
