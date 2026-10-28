// Which Linear issues the planner syncs. By default, the GX capacity planning demo view;
// LINEAR_VIEW can name another issue view (URL, slug or ID), or `all` for the whole workspace.

export const DEFAULT_VIEW_URL =
  'https://linear.app/rideshare-company/view/gx-capacity-planning-demo-subset-30b9a718498a?layout=list&ordering=priority&grouping=project&subGrouping=team&showCompletedIssues=all&showSubIssues=true&showTriageIssues=true';

const DEFAULT_VIEW_SLUG = '30b9a718498a';

/** OOO sample that matches the default view's people. */
export const DEFAULT_VIEW_OOO = 'samples/ooo-gx-capacity-demo.csv';

export interface ViewRef {
  /** What `customView(id:)` is called with: the view's slug or ID. */
  id: string;
  /** Link back to the view, when known. */
  url: string | null;
  isDefault: boolean;
}

/** Parses a view URL, slug or ID. `/view/<name>-<slug>` URLs resolve to the trailing slug. */
export function parseViewRef(input: string): ViewRef | null {
  const raw = input.trim();
  if (!raw || /^(all|none|workspace)$/i.test(raw)) return null;
  const match = /\/view\/([^/?#]+)/.exec(raw);
  if (match) {
    const segment = decodeURIComponent(match[1]);
    // UUIDs contain dashes, so only split a name-slug segment.
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) ? segment : segment.split('-').pop()!;
    return { id, url: raw.split('?')[0], isDefault: id === DEFAULT_VIEW_SLUG };
  }
  return { id: raw, url: null, isDefault: raw === DEFAULT_VIEW_SLUG };
}

/** The view configured by LINEAR_VIEW, or null to sync the whole workspace. */
export function configuredView(): ViewRef | null {
  const env = process.env.LINEAR_VIEW;
  return parseViewRef(env == null ? DEFAULT_VIEW_URL : env);
}
