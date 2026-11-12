import { create } from 'zustand';

/**
 * Colonyn plan modules on the client (mirror of apps/api/src/colonyn/entitlements).
 * The server enforces everything; this only hides menus and explains blocked pages.
 */
export const COLONYN_FEATURES = ['psa', 'ai', 'backup', 'security_plus', 'integrations'] as const;
export type ColonynFeature = (typeof COLONYN_FEATURES)[number];

export const FEATURE_LABELS: Record<ColonynFeature, string> = {
  psa: 'Service Desk & Billing (PSA)',
  ai: 'AI',
  backup: 'Backup & Disaster Recovery',
  security_plus: 'Advanced Security',
  integrations: 'Integrations & Automation',
};

export interface ColonynPlan {
  /** null = no restriction. */
  features: ColonynFeature[] | null;
  maxTechnicians: number | null;
  technicians: number | null;
  upgradeUrl: string | null;
}

interface PlanState {
  plan: ColonynPlan | null;
  setPlan: (plan: ColonynPlan | null) => void;
}

// Not persisted: another user may sign in on the same browser. Until the partner
// read lands, nothing is hidden (the server still enforces the plan).
export const useColonynPlan = create<PlanState>()((set) => ({
  plan: null,
  setPlan: (plan) => set({ plan }),
}));

/** Accepts the `colonyn` object of GET /orgs/partners/me; anything malformed means "no restriction". */
export function normalizePlan(raw: unknown): ColonynPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const features = Array.isArray(value.features)
    ? value.features.filter((f): f is ColonynFeature => (COLONYN_FEATURES as readonly string[]).includes(f as string))
    : null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    features,
    maxTechnicians: num(value.maxTechnicians),
    technicians: num(value.technicians),
    upgradeUrl: typeof value.upgradeUrl === 'string' ? value.upgradeUrl : null,
  };
}

const page = (p: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$|#|\\?)`);

/** Web pages (sidebar hrefs and direct URLs) per module. Order matters only for overlapping prefixes. */
const PAGE_RULES: ReadonlyArray<{ feature: ColonynFeature; pattern: RegExp }> = [
  ...[
    '/tickets', '/timesheet', '/billing/quotes', '/billing/invoices', '/billing/autopay', '/contracts', '/agreements',
    '/settings/catalog', '/settings/deliverable-templates', '/settings/ticketing', '/settings/ticket-checklist-templates',
    '/settings/integrations/psa', '/settings/integrations/ticketing', '/integrations/psa',
  ].map((p) => ({ feature: 'psa' as const, pattern: page(p) })),
  ...[
    '/fleet', '/workspace', '/settings/ai-agents', '/ai-agents', '/settings/ai-usage', '/settings/ai-script-authoring',
    '/ai-for-office', '/ai-risk', '/ai-script-proposals', '/settings/office-addin-bindings',
  ].map((p) => ({ feature: 'ai' as const, pattern: page(p) })),
  ...['/backup', '/c2c', '/dr', '/settings/integrations/backup'].map((p) => ({ feature: 'backup' as const, pattern: page(p) })),
  ...[
    '/security/edr', '/security/user-risk', '/dns-security', '/pam', '/sensitive-data', '/peripherals', '/cis-hardening',
    '/audit-baselines', '/settings/integrations/huntress', '/settings/integrations/security',
  ].map((p) => ({ feature: 'security_plus' as const, pattern: page(p) })),
  ...[
    '/settings/api-keys', '/settings/webhooks', '/integrations', '/settings/sso', '/settings/connected-apps',
    '/settings/partner-service-principals', '/settings/tool-sources',
  ].map((p) => ({ feature: 'integrations' as const, pattern: page(p) })),
];

export function featureForPage(href: string): ColonynFeature | null {
  for (const rule of PAGE_RULES) if (rule.pattern.test(href)) return rule.feature;
  return null;
}

export function isFeatureAllowed(plan: ColonynPlan | null, feature: ColonynFeature | null): boolean {
  if (!feature || !plan || plan.features === null) return true;
  return plan.features.includes(feature);
}

export function isPageAllowed(plan: ColonynPlan | null, href: string): boolean {
  return isFeatureAllowed(plan, featureForPage(href));
}
