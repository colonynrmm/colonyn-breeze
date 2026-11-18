import { COLONYN_FEATURES, type ColonynFeature } from './features';
import { countPlanUsage, countTechnicians, getEntitlements } from './store';

export interface ColonynPlanInfo {
  /** null = every module is available (no Colonyn restriction for this partner). */
  features: ColonynFeature[] | null;
  maxTechnicians: number | null;
  technicians: number | null;
  upgradeUrl: string | null;
  /** Current use, for the Plan & usage page. Technicians are counted even without a limit. */
  usage: { organizations: number; devices: number; technicians: number };
}

/** What the web app needs to hide modules and show seat usage. Never throws. */
export async function colonynPlanInfo(partnerId: string): Promise<ColonynPlanInfo | null> {
  try {
    const { features, maxTechnicians } = await getEntitlements(partnerId);
    const [usage, technicians] = await Promise.all([countPlanUsage(partnerId), countTechnicians(partnerId)]);
    return {
      features: features === null ? null : COLONYN_FEATURES.filter((f) => features.has(f)),
      maxTechnicians,
      technicians: maxTechnicians === null ? null : technicians,
      upgradeUrl: process.env.COLONYN_UPGRADE_URL?.trim() || null,
      usage: { ...usage, technicians },
    };
  } catch (err) {
    console.error('[colonyn] plan info unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}
