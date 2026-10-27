# Linear Capacity Planner

A local web app for Linear teams that answers three questions:

1. **Where are we overcommitted?** Current and future capacity per team (by cycle) and per person (by week).
2. **Why?** Load broken down into planned work, absences, shared commitments (people on several teams), and unplanned work.
3. **What can we do about it?** Rule-based recommendations, each showing the evidence it was built from. Accepted changes are either synced back to Linear or kept as planner-only assumptions. OOO data only changes through a new CSV import.

Data sources:
- **Linear**, through the GraphQL API: teams, members, cycles, issues and issue history.
- **Out-of-office data** from a CSV export of your HR system.

Without an API key it runs on a generated demo workspace, so you can try it right away.

---

## Quick start

Requires Node.js 20 or later.

```bash
git clone https://github.com/greta-11/linear-capacity-planning.git
cd linear-capacity-planning
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. With no API key configured, the header says **Demo data**.

### Add your Linear API key

1. In Linear, open **Settings → Security & access → Personal API keys** and create a key.
   - Read access is enough to view capacity.
   - **Write** access is needed only to apply cycle, assignee or estimate changes from the planner.
2. Add the key to a local `.env` file. It never leaves your machine, and the browser never sees it:

```bash
cp .env.example .env
echo 'LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxx' >> .env
```

To use the key for a single shell session without writing a file:

```bash
export LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxx
```

3. Verify the key and preview what will be pulled (nothing is saved):

```bash
npm run check:linear
```

4. Restart the app (`Ctrl+C`, then `npm run dev`). The header switches to **Linear**. Click **Sync from Linear** at any time to re-pull.

### Provide OOO data (CSV)

Export absences from your HR system into this format. The header row is required; extra columns are ignored.

```csv
email,start_date,end_date,type,fraction,note
ana@acme.dev,2026-11-02,2026-11-10,vacation,1,Family trip
ivan@acme.dev,2026-11-16,2026-11-20,training,0.5,Mornings only
*,2026-11-26,2026-11-27,holiday,1,Company holiday
```

| Column | Meaning |
|---|---|
| `email` | Matched to Linear users by email, case-insensitively. Use `*` for a company-wide day off. |
| `start_date`, `end_date` | Inclusive, `YYYY-MM-DD`. Weekends and non-working days are ignored. |
| `type` | Free text (vacation, sick, holiday…). Shown in explanations. |
| `fraction` | Share of each day that is out. Optional; defaults to `1`. Use `0.5` for half days. |
| `note` | Optional. |

Import it from the terminal:

```bash
# start from the template, or try the sample that matches the demo workspace
cp samples/ooo-template.csv my-ooo.csv
npm run import:ooo -- samples/ooo-sample.csv

# your real export (validate first with --dry-run if you like)
npm run import:ooo -- ~/Downloads/ooo-export.csv --dry-run
npm run import:ooo -- ~/Downloads/ooo-export.csv
```

The command prints how many rows were added or removed compared with the current data, plus any problems:
- unknown emails
- bad dates
- `end_date` before `start_date`
- overlapping rows

Rows with errors are skipped and show up in the app as "Update via CSV" to-dos. The command exits non-zero only when nothing could be imported. Reload the app to see the new data.

You can also import from the UI under **Data sources → Choose CSV…**, which shows the same preview before replacing the data.

**OOO is read-only in the planner.** To change an absence, fix it in your HR system, export again, and re-import.

---

## The views

All views share the **date range** filter (current cycle, next 3 cycles, next 12 weeks, rest of the quarter, or a custom range) and the **team** filter. Both are kept in the URL.

### Team capacity

*Is my team realistically equipped to deliver the work scheduled across upcoming cycles?*

- **KPIs:**
  - available capacity
  - scheduled load
  - headroom or overcommitment
  - cycles at risk
  - people over capacity
- **Per-cycle chart:**
  - stacked load (planned, unplanned added mid-cycle, unplanned reserve, unassigned)
  - available capacity line
  - Linear-style "velocity only" capacity for comparison
  - Hover for the numbers; **Show table** gives an accessible table view.
- **Cycle drill-down** (click a bar):
  - *Where the capacity went*: members' full time − absences − time on other teams = available capacity
  - *Who is carrying it*: each member's share, OOO, load, and overall utilization
  - the cycle's open issues

### Individuals

*Who is overcommitted, and why?*

- **Heatmap:** utilization for each person and week. Cells are tinted by status, with an icon for at-risk and over. A small ring marks weeks with OOO.
- **Table**, with one row per person:
  - velocity (and its source)
  - capacity and load
  - whole-range utilization and peak week
  - a load-vs-capacity breakdown bar (planned, shared commitments, unplanned + reserve, absences)
  - a plain-language **why**, e.g. "7 OOO days (vacation) removes 8.9 pts of capacity · 43.6 pts committed to Web"
- **Expanding a row** shows the capacity math, the evidence behind the velocity, the OOO rows (with their CSV row numbers), and every scheduled issue with the points that land in the range.

### Adjustments

Each recommendation names its destination and has an **evidence panel** with:
- **Trigger:** the metric and threshold that fired, e.g. "Ana in PLT Cycle 47: 12.4 pts load vs 3.8 pts capacity = 326% · over above 115%".
- **Rule:** the rule that produced it.
- **Why this action:** why these issues, this cycle or this teammate.
- **Inputs:** velocity, OOO days, load per team.
- **Source rows:**
  - the Linear issues, with the ones being changed highlighted
  - the OOO CSV rows (file and row number)
  - the cycles used for velocity or unplanned history
- **Freshness:** when Linear was last synced and when the OOO file was imported.

| Rule | Action | Destination |
|---|---|---|
| Person over capacity in a cycle | Move their lowest-priority unstarted issues to the nearest later cycle with room | Sync to Linear (cycle) |
| …and a teammate has room | Alternatively, reassign those issues to the teammate with the most room | Sync to Linear (assignee) |
| Cycle at risk with unestimated issues | Estimate them (values editable before accepting) | Sync to Linear (estimate) |
| Shared person whose time split doesn't match their scheduled work | Set the split | Keep in planner |
| Team's measured unplanned share differs from its reserve | Adjust the unplanned buffer | Keep in planner |
| Velocity based on too little history (e.g. a new joiner) | Set an explicit velocity | Keep in planner |
| OOO rows that couldn't be applied or look wrong | Fix in the HR system and re-import | Update via CSV |

**Why the split between destinations.** Cycle, assignee and estimate are scheduling facts the whole team sees in Linear, so they belong there. Time splits, velocity and unplanned buffers are planning assumptions with no Linear field, so they stay in the planner. OOO is owned by HR.

The **change ledger** groups accepted items by destination:

- **Sync to Linear:**
  - Accepted changes wait here until you click **Review & apply**, pick the changes, and confirm.
  - Before each write, the server re-reads the issue in Linear. If it changed since you accepted (moved, reassigned, closed), the write is skipped rather than overwriting someone's update.
  - Writes use the `issueUpdate` mutation. Afterwards the app re-syncs, so every view reflects the change.
- **Keep in planner:** takes effect immediately, is stored in `data/planner.json` with who and when, and can be reverted.
- **Update via CSV:** to-dos for the OOO source system.

When **Sync from Linear** runs, accepted-but-unapplied changes whose issue changed upstream are flagged **Out of date**.

### Data sources

- Linear connection status and sync history, plus **Sync now**. In demo mode there is also **Reset demo data**.
- OOO import with a preview diff, download of the current data, and the template.
- Planner settings:
  - working days
  - default velocity
  - lookback cycles
  - default unplanned reserve
  - status thresholds
- The planner overrides currently in effect.

---

## How capacity is calculated

Everything is in **estimate points**. Teams with estimates turned off count each issue as 1 point. All figures are computed **from today forward**.

- **Velocity (pts per working day), per person:**
  - Completed points across the last *N* completed cycles of their teams (default 3), divided by their available days in that window.
  - **OOO days are excluded from the denominator**, so a vacation doesn't make someone look slow.
  - Needs 3+ completed issues; otherwise it falls back to the team average, then to the default. It can be overridden in the planner.
- **Capacity** = velocity × (working days − OOO days).
  - Half days count as 0.5.
  - Overlapping OOO rows count once per day.
- **Load:**
  - Each open issue's points are spread evenly over the remaining working days of its cycle. Weekly and range views pick up the share that falls inside them.
  - Unestimated issues count at the team's median estimate and are flagged.
- **Planned vs unplanned:**
  - An issue is unplanned if it entered its cycle after the cycle's first day (from Linear issue history; falls back to the creation date).
  - Future cycles also carry an **unplanned reserve**: the team's buffer (default 10%) × capacity.
- **Shared commitments:**
  - A person's utilization covers all their teams.
  - In a team view, each member contributes capacity × their **time split** for that team. The split defaults to their historical completed points per team and can be overridden.
  - The rest shows as "time on other teams".
- **Status:** under < 70% ≤ healthy ≤ 100% < at risk ≤ 115% < over. All thresholds are configurable.
- Only cycle-scheduled work counts as load. Issues without a cycle, and teams with cycles disabled, contribute capacity but no scheduled load.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API server on `127.0.0.1:4000` plus the UI on `127.0.0.1:5173` (hot reload) |
| `npm run build && npm start` | Production build, served from `http://127.0.0.1:4000` |
| `npm run check:linear` | Verify `LINEAR_API_KEY` and summarise what a sync would pull |
| `npm run import:ooo -- <file.csv> [--dry-run]` | Validate and import an OOO CSV |
| `npm test` | Unit tests (capacity engine, recommendations, CSV parsing) |
| `npm run typecheck` | TypeScript across server, client and tests |

Local state lives in `data/` (gitignored):

| File | Contents |
|---|---|
| `snapshot.json` | Last Linear sync |
| `ooo.json` | Last imported CSV |
| `planner.json` | Settings, overrides, ledger, dismissed recommendations |
| `sync-history.json` | Recent syncs |
| `demo-workspace.json` | Demo mode only |

Delete the folder to start fresh. Set `DATA_DIR` to keep it elsewhere.

## Project layout

```
shared/        Pure TypeScript used by server and browser
  calendar.ts         working days, ranges, week buckets
  capacity.ts         capacity engine (velocity, OOO, load spreading, allocation, summaries)
  recommendations.ts  rules + evidence
  changes.ts          destinations (Linear / planner / CSV), planner apply/revert
server/        Express API (binds to 127.0.0.1 only)
  linear/             GraphQL client (pagination, rate-limit retries), queries, normalisation
  ooo/csv.ts          CSV parse/validate/diff/export
  demo/               demo workspace generator + local stand-in for Linear writes
  service.ts          sync, ledger, apply-to-Linear with conflict checks
scripts/       check-linear.ts, import-ooo.ts
client/        Vite + React UI
samples/       ooo-sample.csv (matches the demo workspace), ooo-template.csv
tests/         Vitest
```
