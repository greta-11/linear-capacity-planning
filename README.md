# Linear Capacity Planner

A local web app for Linear teams that answers three questions:

1. **Can we trust the data?** **Data hygiene** counts open issues the planner can't use well: no date, no estimate, or no project. A banner on every tab points you to fix them directly in Linear.
2. **Where are we overcommitted, and why?** A **capacity heat map** of people and projects, grouped by team, over configurable periods. Click any cell to see the capacity math and what makes up the load.
3. **What can we do about it?** **Recommendations** suggest reassignments within a team, each with its rationale, and flag the overflow that no reassignment can fix. They're read-only: you make the changes in Linear.

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

1. In Linear, open **Settings → Security & access → Personal API keys** and create a key. **Read** access is enough: the planner never writes to Linear.
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

The **data strip** at the top shows each source, when it was last synced, and its **Sync** button. **⚙ Settings** opens Linear connection details, sync history and planner settings (work days, default velocity, lookback, status thresholds and status weights). The tab and every filter are kept in the URL.

### Data hygiene

*Which issues does the planner have to guess about or leave out?*

Every open issue (triage, backlog, todo, in progress, in review) is checked for three problems:

| Flag | Meaning | Effect on the planner | Fix in Linear |
|---|---|---|---|
| **No date** | Not in a current or upcoming cycle, no due date, and no project target date | Can't be placed in time, so it isn't counted in anyone's capacity | Add it to a cycle, set a due date, or put it in a project with a target date |
| **No estimate** | The team uses estimates and the issue has none | Counted at the team's median estimate, so its load is a guess | Estimate it |
| **No project** | Not in a project | Shows as "No project" in the heat map's project view and in remaining overflow | Add it to a project |

The tab shows a card per flag, a table per team, and the flagged issues with an **Open in Linear ↗** link each. Click a card or a team to filter the list.

While any issue is flagged, a banner under the data strip says how many need cleanup, e.g. "⚠ 34 issues need cleanup in Linear: 12 have no date, 9 no estimate, 20 no project. Update them directly in Linear, then Sync." **Review** opens this tab. The banner can be dismissed for the browser session.

### Capacity heat map

*Who and which teams are over capacity, in which period, and why?*

- **Columns** are periods of *x* **weeks, months or quarters**: for example 2 weeks × 6, or 1 quarter × 4. Weeks start on Monday, months on the 1st, quarters in Jan/Apr/Jul/Oct, and the first period starts today.
- **Cells** show utilization (planned load ÷ plannable capacity), tinted by status. A ring marks periods with OOO.
- **Individuals | Projects** toggle. Both views are grouped by team, and each team row compares the team's load with its plannable capacity.
  - **Individuals:** teams expand into their people. Person rows show the person's whole load across all teams and projects. People on several teams appear under each team with an "also on …" chip.
  - **Projects:** teams expand into their projects, plus "No project". A project cell is that project's load for the team in the period ÷ the team's plannable capacity, so a team's project rows add up to the team row. Project cells use a neutral tint, since a single project isn't "over" on its own.
  - Groups start collapsed. Expand one with its ▸ toggle, or use **Expand all teams** / **Collapse all**. A collapsed team still says how many of its people are over capacity.
- **Filters** for projects, teams and people, plus **capacity type** (Over / At risk / Healthy / Under). The capacity type filter keeps a row when any period in view has that status, so you can go straight to the over-capacity rows. Any person, project or capacity type filter expands the groups while it's active.
- **Buffer %** (default 10%) is held back from every person's available capacity, for unplanned work, meetings and support. One value applies to everyone, and Recommendations use it too.
- **Velocity** (applies to every tab):

  | Mode | How each person's points per working day are set |
  |---|---|
  | Historical (default) | Their own completed issues over the last 3 completed cycles, OOO-adjusted. Without enough history, the team average (see below), with a note under their name |
  | Team average | The average historical velocity of their team(s) |
  | Points per week | One number for everyone, converted to points per working day |

  Capacity is computed per working day, so changing the period length rescales it automatically. The toolbar shows the per-period equivalent, e.g. "20 pts per 2-week period".
- **Click any cell** to open a drawer:
  - **Person cell:**
    - the capacity steps: baseline → − OOO → available → − buffer → plannable, with the OOO rows from the CSV
    - what makes up the load: cycle work, work added mid-cycle, unscheduled work (spread to a due date or project target)
    - the load broken down by team and by project
    - every issue in the period, sorted by priority, with its status weight and the share of its points that falls in that period
    - **How this is calculated** notes using this cell's numbers, e.g. "PLT-12 · 5 pts × 50% (In Progress) = 2.5 remaining"
  - **Team cell:** where the capacity went (members' full time − absences − time on other teams − buffer), what the team is asked to carry, its members and its issues.
  - **Project cell:** the project's issues for that team in the period, and its share of the team's plannable capacity.

### Recommendations

*What can we change, and what needs a scope or timeline decision?*

Recommendations use the heat map's periods, buffer and velocity (shown at the top of the tab, with a link to change them) and have their own team filter. They are suggestions only: make the changes in Linear, then **Sync**.

**Reassignments.** For each period in order, and each person over plannable capacity (most over first), the planner moves their not-started issues (triage, backlog, todo), lowest priority first, to the teammate with the most headroom. A teammate can take an issue only if:

- they're on the **same team** as the issue
- they stay within plannable capacity over the issue's **cycle** (or, with no cycle, the window it's spread over)
- they stay within plannable capacity **this period**
- they aren't pushed over plannable capacity **next period**

It keeps going until the person is at or under 100%, or nothing more fits. Work already in progress or in review is never moved. Each card shows the issue, from → to, the points in this period (and in total, if the issue spans periods) and the rationale, e.g. "Sid has 6 pts of headroom this period and 4 next; they'd be at 92% this period and 88% next. Ana goes from 130% to 104%."

People still over capacity afterwards are listed in the same period with the reason, rather than left out:
- "no Platform teammate has headroom this period"
- "teammates with room this period would go over capacity next period"
- "teammates with room this period would go over capacity within the issue's cycle"
- "only work already in progress remains in this period, which isn't moved"
- "no remaining issue fits within a teammate's headroom"

**Remaining overflow.** After every reassignment is applied, each team and period still over capacity gets a flag (not a recommendation) with the points over plannable capacity, the projects driving the load, and the issues involved:
- "Platform exceeds capacity by 8 pts in Nov 9 – Nov 22 after reassignment. Requires a scope or timeline decision."
- "Platform has capacity overall in Nov 9 – Nov 22, but Ana remains over (3 pts) after reassignment. Their remaining work can't be moved within the constraints."

---

## How capacity is calculated

Everything is in **estimate points**. Teams with estimates turned off count each issue as 1 point. All figures are computed **from today forward**.

**Capacity**, per person and period, in this order:

1. **Baseline** = velocity × working days
2. **Available capacity** = baseline × (1 − OOO share), where OOO share = OOO days ÷ working days
3. **Plannable capacity** = available capacity × (1 − buffer %)
4. **Utilization** = planned load (cycle work + spread unscheduled work) ÷ plannable capacity

- **Velocity (pts per working day):**
  - Completed points across the last *N* completed cycles of their teams (default 3), divided by their available days in that window.
  - **OOO days are excluded from the denominator**, so a vacation doesn't make someone look slow.
  - Needs 3+ completed issues. Otherwise it falls back to the **team average**, which only counts teammates with enough history and a velocity above 0. The heat map notes this under the person's name, e.g. "Not enough history (0 completed issues) — using Web team average, 4.7 pts/wk". With no usable teammate history it uses the default velocity from Settings.
- **OOO:** half days count as 0.5, and overlapping rows count once per day.

**Planned load:**
- **Remaining work by status.** Each open issue counts its estimate × a status weight (editable in Settings):

  | Status | Weight |
  |---|---|
  | Triage, Backlog, Todo (not started) | 100% |
  | In Progress (started) | 50% |
  | In Review (a started state whose name contains "review") | 25% |

- **Cycle work:** an issue's remaining points are spread evenly over the remaining working days of its cycle, and each period picks up the share that falls inside it. An issue that entered its cycle after the cycle's first day is shown as *added mid-cycle* (from Linear issue history; falls back to the creation date).
- **Unscheduled work:** open issues with no cycle are spread from today to their **due date**, or else their project's **target date**. If that date has passed, they go on the current week. Issues with no date at all aren't load; they're flagged under Data hygiene.
- Unestimated issues count at the team's median estimate and are flagged.

**Shared commitments:**
- A person's utilization covers all their teams.
- In a team view, each member contributes their plannable capacity × their **time split** for that team. The split defaults to their historical completed points per team.
- The rest shows as "time on other teams".

**Status:** under < 70% ≤ healthy ≤ 100% < at risk ≤ 115% < over. All thresholds are configurable.

---

## Linear API limits

Linear caps every GraphQL query at **10,000 complexity points**, separately from the hourly budget (3,000,000 points for a personal API key). Complexity is scored from the page sizes a query *requests*, not the data it returns, so a small workspace can still hit the cap. The planner keeps each query to one large page and fetches nested lists, such as each team's members, in their own paginated queries. The largest query is about 2,600 points. `npm test` estimates every query and fails if one goes over 5,000.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API server on `127.0.0.1:4000` plus the UI on `127.0.0.1:5173` (hot reload) |
| `npm run build && npm start` | Production build, served from `http://127.0.0.1:4000` |
| `npm run check:linear` | Verify `LINEAR_API_KEY` and summarise what a sync would pull (teams, cycles, issues, projects) |
| `npm run import:ooo -- <file.csv> [--dry-run]` | Validate and import an OOO CSV |
| `npm test` | Unit tests (capacity engine, data hygiene, reassignments, CSV parsing, query complexity) |
| `npm run typecheck` | TypeScript across server, client and tests |

Local state lives in `data/` (gitignored):

| File | Contents |
|---|---|
| `snapshot.json` | Last Linear sync |
| `ooo.json` | Last imported CSV |
| `planner.json` | Planner settings (work days, default velocity, thresholds, status weights) |
| `sync-history.json` | Recent syncs |
| `workday.json` | Last Workday (CSV) sync time |
| `demo-workspace.json` | Demo mode only |

Delete the folder to start fresh. Set `DATA_DIR` to keep it elsewhere.

## Project layout

```
shared/        Pure TypeScript used by server and browser
  calendar.ts         working days, ranges, week/month/quarter periods
  capacity.ts         capacity engine (velocity modes, OOO, buffer, status weights, load spreading, person/team windows)
  hygiene.ts          data hygiene flags (no date, no estimate, no project)
  reassign.ts         reassignments and remaining overflow
server/        Express API (binds to 127.0.0.1 only)
  linear/             GraphQL client (pagination, rate-limit retries), queries, normalisation
  ooo/csv.ts          CSV parse/validate/diff/export
  demo/               demo workspace generator
  service.ts          sync and snapshot loading
scripts/       check-linear.ts, import-ooo.ts
client/        Vite + React UI
samples/       ooo-sample.csv (matches the demo workspace), ooo-template.csv
tests/         Vitest
```
