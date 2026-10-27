import { useState } from 'react';
import { HYGIENE_FLAGS, HYGIENE_INFO } from '../../../shared/hygiene';
import { usePlanner } from '../context';

// App-wide nudge: issues missing what the planner needs are fixed in Linear, then synced.

const DISMISS_KEY = 'hygiene-banner-dismissed';

export function HygieneBanner() {
  const { hygiene, filters, setFilters } = usePlanner();
  const signature = `${hygiene.counts.noDate}-${hygiene.counts.noEstimate}-${hygiene.counts.noProject}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === signature;
    } catch {
      return false;
    }
  });
  if (!hygiene.flagged || dismissed) return null;
  const parts = HYGIENE_FLAGS.filter((f) => hygiene.counts[f] > 0).map((f) => `${hygiene.counts[f]} ${f === 'noDate' ? 'have no date' : HYGIENE_INFO[f].short}`);
  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, signature);
    } catch {
      // Session storage unavailable: the banner just comes back on reload.
    }
  };
  return (
    <div className="banner" role="status" data-testid="hygiene-banner">
      <span className="banner-icon" aria-hidden>
        ⚠
      </span>
      <span>
        <strong>
          {hygiene.flagged} issue{hygiene.flagged === 1 ? ' needs' : 's need'} cleanup in Linear:
        </strong>{' '}
        {parts.join(', ')}. Update them directly in Linear, then Sync.
      </span>
      {filters.view !== 'hygiene' && (
        <button className="btn btn-small" onClick={() => setFilters({ view: 'hygiene' })} data-testid="banner-review">
          Review
        </button>
      )}
      <button className="btn btn-ghost btn-small" onClick={dismiss} aria-label="Dismiss for this session">
        ×
      </button>
    </div>
  );
}
