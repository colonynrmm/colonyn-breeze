import { describe, expect, it } from 'vitest';
import { featureForPage, isPageAllowed, normalizePlan } from './plan';
import { navSections } from '../components/layout/Sidebar';

describe('Colonyn plan (web)', () => {
  it('maps pages to modules', () => {
    expect(featureForPage('/tickets#type=incident')).toBe('psa');
    expect(featureForPage('/billing/invoices')).toBe('psa');
    expect(featureForPage('/integrations/psa')).toBe('psa');
    expect(featureForPage('/integrations/webhooks')).toBe('integrations');
    expect(featureForPage('/workspace')).toBe('ai');
    expect(featureForPage('/ai-agents/runs')).toBe('ai');
    expect(featureForPage('/c2c')).toBe('backup');
    expect(featureForPage('/security/edr')).toBe('security_plus');
    expect(featureForPage('/security')).toBeNull();
    expect(featureForPage('/settings/billing')).toBeNull(); // the MSP's own subscription
    expect(featureForPage('/devices')).toBeNull();
  });

  it('allows everything without a plan or with an unrestricted plan', () => {
    expect(isPageAllowed(null, '/tickets')).toBe(true);
    expect(isPageAllowed(normalizePlan({ features: null }), '/tickets')).toBe(true);
    expect(isPageAllowed(normalizePlan(undefined), '/tickets')).toBe(true);
  });

  it('hides modules outside the plan', () => {
    const plan = normalizePlan({ features: ['psa', 'bogus'], maxTechnicians: 3, technicians: 1, upgradeUrl: 'https://x' });
    expect(plan?.features).toEqual(['psa']);
    expect(isPageAllowed(plan, '/tickets')).toBe(true);
    expect(isPageAllowed(plan, '/backup')).toBe(false);
    expect(isPageAllowed(plan, '/devices')).toBe(true);
  });

  it('covers every sidebar entry of the gated sections', () => {
    const sections: Record<string, string> = {
      'service-desk': 'psa', billing: 'psa', ai: 'ai', backup: 'backup',
    };
    const missing: string[] = [];
    for (const section of navSections) {
      const expected = sections[section.id];
      if (!expected) continue;
      for (const item of section.items) {
        // Tool Sources sits in the AI section but belongs to Integrations.
        const feature = featureForPage(item.href);
        if (!feature) missing.push(`${section.id}: ${item.href}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps Security overview and IOC scans in core and gates the rest of Security', () => {
    const security = navSections.find((s) => s.id === 'security')!;
    const core = security.items.filter((i) => featureForPage(i.href) === null).map((i) => i.href);
    expect(core.sort()).toEqual(['/security', '/security/scans']);
  });
});
