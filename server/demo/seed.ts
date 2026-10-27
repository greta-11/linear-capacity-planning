import { addDays, countWorkingDays, maxDay, weekStart } from '../../shared/calendar';
import type { Cycle, Day, Issue, Person, Snapshot, StateType, Team } from '../../shared/types';

// Deterministic demo workspace, generated relative to `today` so there is always
// an active cycle. It is built to show each kind of overcommitment:
//  - Ana (Platform) is out most of next cycle while fully planned → defer
//  - Ben (Platform) has room → reassign target
//  - Dana is on Platform and Web; her scheduled work leans on Web → shared + allocation
//  - Gus (Web) just joined, no history → velocity
//  - Web's next cycle has unestimated issues → estimate
//  - Mobile pulls in ~30% unplanned work every cycle → unplanned buffer

const WORK_DAYS = [1, 2, 3, 4, 5];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoPerson {
  id: string;
  name: string;
  email: string;
  teams: string[];
  velocity: number;
  /** Share of past work per team. */
  history: Record<string, number>;
  joinedRecently?: boolean;
  /** Target utilization of remaining capacity per team, per upcoming cycle index (0 = active). */
  plan: Record<string, number[]>;
}

const TEAMS: { id: string; key: string; name: string; weeks: number; offsetWeeks: number; unplannedRate: number }[] = [
  { id: 'team-plt', key: 'PLT', name: 'Platform', weeks: 2, offsetWeeks: -1, unplannedRate: 0.08 },
  { id: 'team-web', key: 'WEB', name: 'Web', weeks: 2, offsetWeeks: 0, unplannedRate: 0.1 },
  { id: 'team-mob', key: 'MOB', name: 'Mobile', weeks: 1, offsetWeeks: 0, unplannedRate: 0.3 },
];

const PEOPLE: DemoPerson[] = [
  { id: 'u-ana', name: 'Ana Ruiz', email: 'ana@acme.dev', teams: ['team-plt'], velocity: 1.2, history: { 'team-plt': 1 }, plan: { 'team-plt': [1.0, 1.05, 0.35, 0.8, 0.7, 0.6, 0.5] } },
  { id: 'u-ben', name: 'Ben Okafor', email: 'ben@acme.dev', teams: ['team-plt'], velocity: 1.0, history: { 'team-plt': 1 }, plan: { 'team-plt': [0.45, 0.4, 0.5, 0.45, 0.4, 0.3, 0.3] } },
  { id: 'u-chen', name: 'Chen Wei', email: 'chen@acme.dev', teams: ['team-plt'], velocity: 1.1, history: { 'team-plt': 1 }, plan: { 'team-plt': [0.95, 0.9, 0.85, 0.8, 0.6, 0.5, 0.4] } },
  { id: 'u-dana', name: 'Dana Kim', email: 'dana@acme.dev', teams: ['team-plt', 'team-web'], velocity: 1.0, history: { 'team-plt': 0.6, 'team-web': 0.4 }, plan: { 'team-plt': [0.35, 0.35, 0.3, 0.3, 0.2, 0.2, 0.2], 'team-web': [0.85, 0.9, 0.8, 0.6, 0.5, 0.4, 0.3] } },
  { id: 'u-eli', name: 'Eli Novak', email: 'eli@acme.dev', teams: ['team-web'], velocity: 1.1, history: { 'team-web': 1 }, plan: { 'team-web': [0.95, 0.9, 0.85, 0.7, 0.6, 0.5, 0.4] } },
  { id: 'u-farah', name: 'Farah Haddad', email: 'farah@acme.dev', teams: ['team-web'], velocity: 0.9, history: { 'team-web': 1 }, plan: { 'team-web': [0.8, 0.85, 0.75, 0.7, 0.6, 0.5, 0.4] } },
  { id: 'u-gus', name: 'Gus Lindqvist', email: 'gus@acme.dev', teams: ['team-web'], velocity: 0.8, history: {}, joinedRecently: true, plan: { 'team-web': [0.7, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3] } },
  { id: 'u-hana', name: 'Hana Sato', email: 'hana@acme.dev', teams: ['team-mob'], velocity: 1.0, history: { 'team-mob': 1 }, plan: { 'team-mob': [0.85, 0.85, 0.8, 0.8, 0.75, 0.7, 0.6, 0.6, 0.5, 0.5, 0.4, 0.4] } },
  { id: 'u-ivan', name: 'Ivan Petrov', email: 'ivan@acme.dev', teams: ['team-mob'], velocity: 1.2, history: { 'team-mob': 1 }, plan: { 'team-mob': [0.95, 0.95, 0.9, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.5, 0.4, 0.4] } },
  { id: 'u-jo', name: 'Jo Mensah', email: 'jo@acme.dev', teams: ['team-mob'], velocity: 0.9, history: { 'team-mob': 1 }, plan: { 'team-mob': [0.75, 0.7, 0.7, 0.65, 0.6, 0.6, 0.5, 0.5, 0.4, 0.4, 0.3, 0.3] } },
  { id: 'u-kai', name: 'Kai Brennan', email: 'kai@acme.dev', teams: ['team-mob'], velocity: 1.0, history: { 'team-mob': 1 }, plan: { 'team-mob': [0.7, 0.75, 0.7, 0.7, 0.9, 0.9, 0.6, 0.5, 0.5, 0.4, 0.4, 0.3] } },
];

const TITLES: Record<string, string[]> = {
  'team-plt': ['Rate limiter for public API', 'Migrate jobs to new queue', 'Shard audit log table', 'Rotate service credentials', 'Retry policy for webhooks', 'Upgrade Postgres to 17', 'Trace sampling config', 'Cache warmup on deploy', 'Cleanup orphaned blobs', 'Tenant export pipeline', 'Feature flag service SDK', 'Reduce cold start time', 'Alert routing rules', 'Backfill billing events', 'Search index rebuild tool'],
  'team-web': ['Redesign settings page', 'Keyboard shortcuts help', 'Onboarding checklist', 'Dark mode polish', 'Table virtualization', 'Inline editing for titles', 'Command menu ranking', 'Empty states', 'Accessibility audit fixes', 'Billing page revamp', 'Saved filters', 'Bulk actions toolbar', 'Notification preferences', 'Drag and drop reorder', 'Markdown paste handling'],
  'team-mob': ['Offline sync conflicts', 'Push notification deep links', 'iPad split view', 'Biometric login', 'Image upload retries', 'Widget for today view', 'Crash on resume (Android)', 'Reduce app size', 'Pull to refresh jank', 'Share extension', 'Login loop on token expiry', 'Haptics polish', 'Background fetch tuning', 'Dark mode icons', 'Voice input'],
};
const BUG_TITLES = ['Crash when opening attachment', 'Sync stuck after network change', 'Wrong badge count', 'Login fails for SSO users', 'Duplicate push notifications', 'Scroll position resets', 'Timezone off by one in due dates', 'Payment sheet freezes'];
const SIZES = [1, 2, 3, 5, 8];

function cyclesFor(team: (typeof TEAMS)[number], today: Day): Cycle[] {
  const len = team.weeks * 7;
  const anchor = addDays(weekStart(today), team.offsetWeeks * 7);
  const pastCount = 6;
  const futureCount = Math.ceil((7 * 18) / len);
  const out: Cycle[] = [];
  for (let i = -pastCount; i <= futureCount; i++) {
    const startDate = addDays(anchor, i * len);
    const endDate = addDays(startDate, len - 1);
    const number = 40 + pastCount + i;
    out.push({
      id: `${team.id}-c${number}`,
      teamId: team.id,
      number,
      name: null,
      startDate,
      endDate,
      completedAt: endDate < today ? `${addDays(endDate, 1)}T00:01:00.000Z` : null,
    });
  }
  return out;
}

export function demoSnapshot(today: Day, fetchedAt = new Date().toISOString()): Snapshot {
  const rand = rng(42);
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const teams: Team[] = TEAMS.map((t) => ({
    id: t.id,
    key: t.key,
    name: t.name,
    cyclesEnabled: true,
    cycleDuration: t.weeks,
    estimationType: 'fibonacci',
    timezone: 'UTC',
    memberIds: PEOPLE.filter((p) => p.teams.includes(t.id)).map((p) => p.id),
  }));
  const people: Person[] = PEOPLE.map((p) => ({ id: p.id, name: p.name, displayName: p.name.split(' ')[0], email: p.email, avatarUrl: null, active: true, teamIds: p.teams }));
  const cycles = TEAMS.flatMap((t) => cyclesFor(t, today));
  const issues: Issue[] = [];
  const counters: Record<string, number> = {};
  const titleIdx: Record<string, number> = {};

  const makeIssue = (teamId: string, cycle: Cycle, opts: { assigneeId: string | null; estimate: number | null; state: StateType; unplanned?: boolean; priority?: number; title?: string }) => {
    const team = TEAMS.find((t) => t.id === teamId)!;
    counters[teamId] = (counters[teamId] ?? 100) + 1;
    const identifier = `${team.key}-${counters[teamId]}`;
    const titles = TITLES[teamId];
    titleIdx[teamId] = ((titleIdx[teamId] ?? -1) + 1) % titles.length;
    const cycleLen = countWorkingDays(cycle.startDate, cycle.endDate, WORK_DAYS);
    const addedDay = opts.unplanned ? addDays(cycle.startDate, 1 + Math.floor(rand() * Math.max(1, cycleLen - 2))) : addDays(cycle.startDate, -2);
    const created = `${addDays(addedDay, opts.unplanned ? 0 : -Math.floor(rand() * 20))}T10:00:00.000Z`;
    const completedAt = opts.state === 'completed' ? `${addDays(cycle.startDate, Math.floor(rand() * team.weeks * 7))}T16:00:00.000Z` : null;
    const stateName: Record<StateType, string> = { triage: 'Triage', backlog: 'Backlog', unstarted: 'Todo', started: 'In Progress', completed: 'Done', canceled: 'Canceled' };
    issues.push({
      id: `iss-${identifier.toLowerCase()}`,
      identifier,
      title: opts.title ?? (opts.unplanned ? pick(BUG_TITLES) : titles[titleIdx[teamId]]),
      url: `https://linear.app/acme/issue/${identifier}`,
      teamId,
      cycleId: cycle.id,
      assigneeId: opts.assigneeId,
      estimate: opts.estimate,
      priority: opts.priority ?? (opts.unplanned ? 2 : 1 + Math.floor(rand() * 4)),
      stateType: opts.state,
      stateName: stateName[opts.state],
      projectName: opts.unplanned ? null : `${team.name} Q4`,
      labels: opts.unplanned ? ['Bug'] : ['Feature'],
      createdAt: created,
      updatedAt: completedAt ?? `${addDays(today, -1)}T12:00:00.000Z`,
      completedAt,
      canceledAt: null,
      addedToCycleAt: `${addedDay}T${opts.unplanned ? '14' : '09'}:00:00.000Z`,
    });
  };

  const fill = (target: number, add: (size: number) => void) => {
    let remaining = target;
    while (remaining >= 0.75) {
      const fits = SIZES.filter((s) => s <= remaining + 0.5);
      const size = fits.length ? fits[Math.min(fits.length - 1, Math.floor(rand() * fits.length))] : 1;
      add(size);
      remaining -= size;
    }
  };

  for (const team of TEAMS) {
    const teamCycles = cycles.filter((c) => c.teamId === team.id);
    const members = PEOPLE.filter((p) => p.teams.includes(team.id));
    let upcomingIndex = 0;
    for (const cycle of teamCycles) {
      const days = countWorkingDays(cycle.startDate, cycle.endDate, WORK_DAYS);
      if (cycle.endDate < today) {
        // History: completed work at roughly each person's velocity, some of it unplanned.
        for (const p of members) {
          const share = p.history[team.id] ?? 0;
          if (!share) continue;
          const target = p.velocity * days * share * (0.85 + rand() * 0.25);
          fill(target, (size) => makeIssue(team.id, cycle, { assigneeId: p.id, estimate: size, state: 'completed', unplanned: rand() < team.unplannedRate }));
        }
        continue;
      }
      // Active + upcoming: open work sized against remaining capacity.
      const isActive = cycle.startDate <= today;
      const remainingDays = countWorkingDays(maxDay(cycle.startDate, today), cycle.endDate, WORK_DAYS);
      for (const p of members) {
        const plan = p.plan[team.id] ?? [];
        const util = plan[upcomingIndex] ?? 0;
        if (!util) continue;
        const velocity = p.joinedRecently ? 0.95 : p.velocity;
        const target = velocity * remainingDays * util;
        let first = true;
        fill(target, (size) => {
          const state: StateType = isActive && first ? 'started' : 'unstarted';
          first = false;
          makeIssue(team.id, cycle, { assigneeId: p.id, estimate: size, state });
        });
        if (isActive) {
          // Completed work earlier in the active cycle (doesn't count toward remaining load).
          makeIssue(team.id, cycle, { assigneeId: p.id, estimate: 2, state: 'completed' });
        }
      }
      if (isActive && team.id === 'team-mob') {
        makeIssue(team.id, cycle, { assigneeId: 'u-ivan', estimate: 3, state: 'started', unplanned: true, priority: 1, title: 'Crash on launch for iOS 18.1 users' });
        makeIssue(team.id, cycle, { assigneeId: 'u-hana', estimate: 2, state: 'unstarted', unplanned: true, priority: 2, title: 'Push tokens not refreshed after reinstall' });
      }
      if (isActive && team.id === 'team-plt') {
        makeIssue(team.id, cycle, { assigneeId: 'u-ana', estimate: 3, state: 'unstarted', unplanned: true, priority: 2, title: 'Hotfix: webhook signature mismatch' });
      }
      if (team.id === 'team-web' && upcomingIndex === 1) {
        for (const [assigneeId, title] of [
          ['u-eli', 'Spike: collaborative cursors'],
          ['u-farah', 'Audit log UI'],
          ['u-dana', 'SSO settings page'],
          [null, 'Rich link previews'],
        ] as const) {
          makeIssue(team.id, cycle, { assigneeId, estimate: null, state: 'backlog', priority: 3, title });
        }
      }
      if (team.id === 'team-plt' && upcomingIndex === 1) {
        makeIssue(team.id, cycle, { assigneeId: null, estimate: 3, state: 'unstarted', priority: 4, title: 'Document on-call runbooks' });
      }
      upcomingIndex++;
    }
  }

  return { source: 'demo', organizationName: 'Acme (demo)', urlKey: 'acme', fetchedAt, demoSeedDay: today, teams, people, cycles, issues };
}

/** OOO CSV for the demo workspace, relative to `today`. Also written to samples/ooo-sample.csv. */
export function demoOooCsv(today: Day): string {
  const week = weekStart(today);
  const pltNext = addDays(week, 7); // Platform's next cycle starts next Monday
  const rows: string[][] = [
    ['email', 'start_date', 'end_date', 'type', 'fraction', 'note'],
    ['ana@acme.dev', pltNext, addDays(pltNext, 8), 'vacation', '1', 'Family trip'],
    ['*', addDays(week, 7 * 4 + 3), addDays(week, 7 * 4 + 4), 'holiday', '1', 'Company holiday'],
    ['hana@acme.dev', addDays(week, 7 * 2 + 1), addDays(week, 7 * 2 + 1), 'sick', '1', ''],
    ['hana@acme.dev', addDays(week, 7 * 2 + 1), addDays(week, 7 * 2 + 2), 'sick', '1', 'duplicate from HR export'],
    ['ivan@acme.dev', addDays(week, 7 * 3), addDays(week, 7 * 3 + 4), 'training', '0.5', 'Mornings only'],
    ['kai@acme.dev', addDays(week, 7 * 4), addDays(week, 7 * 5 + 4), 'parental leave', '1', ''],
    ['jo@acme.dev', addDays(week, 7 * 6 + 3), addDays(week, 7 * 6 + 4), 'vacation', '1', ''],
    ['chen@acme.dev', addDays(week, 7 * 8), addDays(week, 7 * 8 + 4), 'conference', '1', 'KubeCon'],
    ['contractor@acme.dev', addDays(week, 7), addDays(week, 11), 'vacation', '1', 'Not a Linear user'],
  ];
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
