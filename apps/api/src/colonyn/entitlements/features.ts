/**
 * Colonyn plan modules. A tenant (Breeze partner) gets a subset of these from
 * its Colonyn subscription; everything outside the list below is core RMM and
 * always available. The keys are a wire contract with Odoo (colonyn_rmm) and
 * the Bridge: never rename one.
 */
export const COLONYN_FEATURES = ['psa', 'ai', 'backup', 'security_plus', 'integrations'] as const;
export type ColonynFeature = (typeof COLONYN_FEATURES)[number];

export function isColonynFeature(value: unknown): value is ColonynFeature {
  return typeof value === 'string' && (COLONYN_FEATURES as readonly string[]).includes(value);
}

export const FEATURE_LABELS: Record<ColonynFeature, string> = {
  psa: 'Service Desk & Billing (PSA)',
  ai: 'AI',
  backup: 'Backup & Disaster Recovery',
  security_plus: 'Advanced Security',
  integrations: 'Integrations & Automation',
};
