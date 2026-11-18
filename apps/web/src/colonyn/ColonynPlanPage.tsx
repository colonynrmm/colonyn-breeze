import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/stores/auth';
import { COLONYN_FEATURES, FEATURE_LABELS, normalizePlan, type ColonynPlan } from './plan';

/**
 * COLONYN: "Plan & usage" — what the tenant's Colonyn subscription includes and
 * how much of it is used. Read-only; the subscription itself is managed in the
 * customer portal (upgradeUrl). Data comes from GET /orgs/partners/me.
 */
interface PartnerLimits {
  name: string | null;
  maxOrganizations: number | null;
  maxDevices: number | null;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; partner: PartnerLimits; plan: ColonynPlan | null };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function UsageCard({ label, used, max }: { label: string; used: number | null; max: number | null }) {
  const pct = max && used !== null ? Math.min(100, Math.round((used / max) * 100)) : null;
  const over = max !== null && used !== null && used > max;
  const full = max !== null && used !== null && used >= max;
  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm" data-testid={`colonyn-usage-${label.toLowerCase()}`}>
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">
        {used ?? '–'}
        <span className="text-base font-normal text-muted-foreground"> / {max === null ? 'Unlimited' : max}</span>
      </p>
      {pct !== null && (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${full ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {max !== null && used !== null && (
        <p className={`mt-2 text-xs ${full ? 'text-destructive' : 'text-muted-foreground'}`}>
          {over ? `${used - max} over the limit` : full ? 'Limit reached' : `${max - used} remaining`}
        </p>
      )}
    </div>
  );
}

export default function ColonynPlanPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/orgs/partners/me')
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setState({
            kind: 'error',
            message: r.status === 403 || r.status === 404
              ? 'Plan details are only available to administrators of the account.'
              : 'Plan details could not be loaded. Please try again.',
          });
          return;
        }
        const data = (await r.json()) as Record<string, unknown>;
        if (cancelled) return;
        setState({
          kind: 'ready',
          partner: {
            name: typeof data.name === 'string' ? data.name : null,
            maxOrganizations: num(data.maxOrganizations),
            maxDevices: num(data.maxDevices),
          },
          plan: normalizePlan(data.colonyn),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: 'Plan details could not be loaded. Please try again.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-lg border bg-card p-5 text-sm text-muted-foreground" role="alert">
        {state.message}
      </div>
    );
  }

  const { partner, plan } = state;
  const features = plan?.features ?? null;

  return (
    <div className="space-y-6" data-testid="colonyn-plan-page">
      <div className="grid gap-4 sm:grid-cols-3">
        <UsageCard label="Devices" used={plan?.usage.devices ?? null} max={partner.maxDevices} />
        <UsageCard label="Organizations" used={plan?.usage.organizations ?? null} max={partner.maxOrganizations} />
        <UsageCard label="Technicians" used={plan?.usage.technicians ?? null} max={plan?.maxTechnicians ?? null} />
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <h2 className="text-base font-semibold">Modules</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Monitoring, remote access, patching, scripting, alerts and reports are part of every plan.
        </p>
        <ul className="mt-4 divide-y">
          {COLONYN_FEATURES.map((feature) => {
            const included = features === null || features.includes(feature);
            return (
              <li key={feature} className="flex items-center justify-between py-3 text-sm">
                <span>{FEATURE_LABELS[feature]}</span>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    included ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {included ? 'Included' : 'Not in your plan'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {plan?.upgradeUrl && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-5 shadow-sm">
          <p className="text-sm text-muted-foreground">
            Change your plan, add devices, technicians or modules, and see your invoices in the customer portal.
          </p>
          <a
            href={plan.upgradeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Manage subscription
          </a>
        </div>
      )}
    </div>
  );
}
