# Linear Capacity Planner

A local web app for Linear teams that answers three questions:

1. **Which projects are at risk?** A risk score per project, built from the capacity of the people doing the work through its target date.
2. **Where are we overcommitted, and why?** A capacity heat map of people and teams over configurable periods. Click any cell to see what makes up the load: planned work, absences, shared commitments (people on several teams), and unplanned work.
3. **What can we do about it?** Rule-based recommendations, each showing the evidence it was built from. Accepted changes are either synced back to Linear or kept as planner-only assumptions. OOO data only changes through a new CSV import.

Data sources, shown in the strip at the top of the app, each with its own **Sync** button:
- **Linear**, through the GraphQL API: teams, members, cycles, projects, issues and issue history.
- **Workday OOO**, from a CSV export. There is no live Workday connection: **Sync** re-reads and re-validates the imported export, and **Import CSV** loads a new one.

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

Open **http://127.0.0.1:5173**. With no API key configured, the Linear card says **Demo data**.

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

4. Restart the app (`Ctrl+C`, then `npm run dev`). The Linear card switches to **Live**. Click **Sync** on the Linear card at any time to re-pull.

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

You can also import from the UI with **Import CSV** on the Workday card, which shows the same preview before replacing the data.

**OOO is read-only in the planner.** To change an absence, fix it in your HR system, export again, and re-import.

---

## The views

The **data strip** at the top shows each source, when it was last synced, and its **Sync** button. **⚙ Settings** opens Linear connection details, sync history, planner settings and the overrides in effect. The tab and every filter are kept in the URL.

### Project risk

*Which projects are at risk of not being delivered?*

Open projects are sorted by risk score (0–100). Each row shows:
- the level (High ≥ 50, Medium ≥ 25, Low)
- the target date and days left
- the **number of teams and people** involved
- remaining points and open issues, and Linear's own progress and health
- the top drivers, e.g. "Ana 204% through Nov 20 (7 OOO days)"

The score is computed over the window from today to the target date. Projects without a target date use the next 12 weeks and are flagged.

| Factor | Weight | How it's measured |
|---|---|---|
| Capacity pressure | 60% | For each person with project work: their utilization through the target date, counting **all** their work (other projects and teams) and OOO. Each person contributes `(utilization − 85%) ÷ 50%`, capped to 0–100%. The project value is the average, weighted by each person's share of the project's points. |
| Scheduled after target | 20% | Points in cycles that end after the target date ÷ remaining points |
| Unassigned | 12% | Unassigned points ÷ remaining points |
| Unestimated | 8% | Unestimated points (counted at the team median) ÷ remaining points |

`score = Σ weight × factor`. A project past its target date with open work scores 100.

Expanding a row shows the factor table with each factor's contribution, the people involved (their project points, all their load and their capacity through the target date) and the open issues, with issues scheduled after the target highlighted. **Open in heat map** jumps to the heat map filtered to that project.

### Capacity heat map

*Who and which teams are over capacity, in which period, and why?*

- **Columns** are periods of *x* **weeks, months or quarters**: for example 2 weeks × 6, or 1 quarter × 4. Weeks start on Monday, months on the 1st, quarters in Jan/Apr/Jul/Oct, and the first period starts today.
- **Cells** show load as a % of capacity, tinted by status. A ring marks periods with OOO.
- **Rows are grouped by team**, and groups start collapsed, so the default is a team-level view.
  - Expand a team with its ▸ toggle, or use **Show people** / **Team view** to expand or collapse every group.
  - A collapsed team still says how many of its people are over capacity in some period.
  - A person or project filter expands every group while it's active.
  - Each team's summary row compares the team's work with its members' time on that team.
  - Person rows show the person's whole load across all teams and projects.
  - People on several teams appear under each team with an "also on …" chip.
- **Filters** for projects, teams and people. A project filter keeps the people working on that project and outlines the cells that contain its work.
- **Velocity** (applies to every tab):

  | Mode | How each person's points per working day are set |
  |---|---|
  | Historical (default) | Their own completed issues over the last 3 completed cycles, OOO-adjusted |
  | Team average | The average historical velocity of their team(s) |
  | Points per week | One number for everyone, converted to points per working day |

  Capacity is computed per working day, so changing the period length rescales it automatically. The toolbar shows the per-period equivalent, e.g. "20 pts per 2-week period".
- **Click any cell** to open a drawer:
  - **Person cell:**
    - the capacity math (velocity, working days, OOO rows from the CSV)
    - what makes up the load (planned cycle work, work added mid-cycle, unscheduled project work, unplanned reserve)
    - the load broken down by team and by project
    - every issue in the period, sorted by priority, with the share of its points that falls in that period
    - **How this is calculated** notes for *Added mid-cycle*, *Unscheduled project work* and *Unplanned reserve*, using this cell's numbers, e.g. "5 pts over 19 working days, 10 in this period = 2.6 pts" or "0.63 pts/day × 10 days × 100% × 10% buffer = 0.6 pts"
  - **Team cell:**
    - where the capacity went (members' full time − absences − time on other teams)
    - what the team is asked to carry
    - its members
    - its issues

### Recommendations [WIP]

This tab is a work in progress. Recommendations have their own cycle-range and team filters.


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

When Linear is synced, accepted-but-unapplied changes whose issue changed upstream are flagged **Out of date**.

---

## How capacity is calculated

Everything is in **estimate points**. Teams with estimates turned off count each issue as 1 point. All figures are computed **from today forward**.

- **Velocity (pts per working day), per person:**
  - Completed points across the last *N* completed cycles of their teams (default 3), divided by their available days in that window.
  - **OOO days are excluded from the denominator**, so a vacation doesn't make someone look slow.
  - Needs 3+ completed issues; otherwise it falls back to the team average, then to the default. It can be overridden in the planner.
  - The heat map's velocity control can switch every tab to the team average or to a fixed number of points per week.
- **Capacity** = velocity × (working days − OOO days).
  - Half days count as 0.5.
  - Overlapping OOO rows count once per day.
- **Load:**
  - Each open issue's points are spread evenly over the remaining working days of its cycle. Any period picks up the share that falls inside it.
  - **Unscheduled project work:** open project issues with no cycle are spread from today to the project's target date. If the target date has passed, they go on the current week. Issues in projects with no target date don't count as load, but they do count in that project's risk.
  - Unestimated issues count at the team's median estimate and are flagged.
- **Planned vs unplanned:**
  - An issue is unplanned if it entered its cycle after the cycle's first day (from Linear issue history; falls back to the creation date).
  - Future cycles also carry an **unplanned reserve**: the team's buffer (default 10%) × capacity.
- **Shared commitments:**
  - A person's utilization covers all their teams.
  - In a team view, each member contributes capacity × their **time split** for that team. The split defaults to their historical completed points per team and can be overridden.
  - The rest shows as "time on other teams".
- **Status:** under < 70% ≤ healthy ≤ 100% < at risk ≤ 115% < over. All thresholds are configurable.
- Work with neither a cycle nor a dated project doesn't count as load. Teams with cycles disabled therefore contribute only their project work.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API server on `127.0.0.1:4000` plus the UI on `127.0.0.1:5173` (hot reload) |
| `npm run build && npm start` | Production build, served from `http://127.0.0.1:4000` |
| `npm run check:linear` | Verify `LINEAR_API_KEY` and summarise what a sync would pull (teams, cycles, issues, projects) |
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
| `workday.json` | Last Workday (CSV) sync time |
| `demo-workspace.json` | Demo mode only |

Delete the folder to start fresh. Set `DATA_DIR` to keep it elsewhere.

## Project layout

```
shared/        Pure TypeScript used by server and browser
  calendar.ts         working days, ranges, week/month/quarter periods
  capacity.ts         capacity engine (velocity modes, OOO, load spreading, allocation, person/team windows)
  projects.ts         project risk score and factors
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
