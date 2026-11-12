import { useEffect, useState } from 'react';
import { FEATURE_LABELS, featureForPage, isFeatureAllowed, useColonynPlan } from './plan';

/**
 * Covers the page content when the page belongs to a Colonyn module the
 * tenant's plan does not include. The API already refuses the data; this turns
 * a page full of errors into one clear message with an upgrade link.
 */
export default function ColonynPlanGate() {
  const plan = useColonynPlan((s) => s.plan);
  const [path, setPath] = useState<string>(() => (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.hash));

  useEffect(() => {
    const update = () => setPath(window.location.pathname + window.location.hash);
    document.addEventListener('astro:after-swap', update);
    window.addEventListener('hashchange', update);
    return () => {
      document.removeEventListener('astro:after-swap', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);

  const feature = featureForPage(path);
  if (!feature || isFeatureAllowed(plan, feature)) return null;

  return (
    <div
      id="colonyn-plan-gate"
      role="alertdialog"
      aria-labelledby="colonyn-plan-gate-title"
      className="flex items-start justify-center p-6 pt-16"
    >
      {/* Hide the page's own content (it would only show load errors). */}
      <style>{'main > *:not(:has(#colonyn-plan-gate)) { display: none !important; }'}</style>
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
        <h2 id="colonyn-plan-gate-title" className="text-lg font-semibold">
          {FEATURE_LABELS[feature]} is not in your plan
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your Colonyn subscription does not include this module. Your existing data is kept and becomes available
          again as soon as the module is added to your plan.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {plan?.upgradeUrl && (
            <a
              href={plan.upgradeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Upgrade plan
            </a>
          )}
          <a
            href="/"
            className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            Back to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
