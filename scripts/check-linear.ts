import 'dotenv/config';
import { localToday } from '../shared/calendar';
import { LinearError } from '../server/linear/client';
import { fetchSnapshot, fetchViewer } from '../server/linear/queries';
import { store } from '../server/store';

// Verifies LINEAR_API_KEY and prints what the planner would pull, without saving anything.

const key = process.env.LINEAR_API_KEY?.trim();
if (!key) {
  console.log('No LINEAR_API_KEY set → the app runs in demo mode with sample data.');
  console.log('To use your workspace: cp .env.example .env, then set LINEAR_API_KEY=lin_api_... (or export it in your shell).');
  process.exit(0);
}

try {
  const { organization, viewer } = await fetchViewer(key);
  console.log(`✓ Authenticated as ${viewer.name} <${viewer.email}> in ${organization.name}`);
  const snap = await fetchSnapshot(key, localToday(), store.planner().settings.lookbackCycles, (m) => console.log(`  fetched ${m}`));
  console.log('');
  for (const team of snap.teams) {
    const cycles = snap.cycles.filter((c) => c.teamId === team.id);
    const issues = snap.issues.filter((i) => i.teamId === team.id);
    const unestimated = issues.filter((i) => i.estimate == null).length;
    console.log(
      `${team.key.padEnd(6)} ${team.name.padEnd(24)} members ${String(team.memberIds.length).padStart(3)}  cycles ${String(cycles.length).padStart(3)}  issues ${String(issues.length).padStart(4)}` +
        `${team.cyclesEnabled ? '' : '  (cycles disabled — no scheduled load)'}${team.estimationType === 'notUsed' ? '  (no estimates — counting issues)' : unestimated ? `  (${unestimated} unestimated)` : ''}`,
    );
  }
  const noEmail = snap.people.filter((p) => !p.email).length;
  console.log(`\n${snap.people.length} people${noEmail ? `, ${noEmail} without a visible email (OOO rows can't match them)` : ''}.`);
  console.log('✓ Queries work. Run `npm run dev` and click "Sync from Linear" to load this into the planner.');
} catch (err) {
  console.error(`✗ ${err instanceof LinearError ? err.message : (err as Error).stack}`);
  process.exit(1);
}
