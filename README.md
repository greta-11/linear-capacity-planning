# Linear Capacity Planner

A local web app for Linear teams that answers three questions:

1. **Can we trust the data?** **Data hygiene** counts open issues the planner can't use well: no date, no estimate, or no project. A banner on every tab points you to fix them directly in Linear.
2. **Where are we overcommitted, and why?** A **capacity heat map** of people and projects, grouped by team, over configurable periods. Click any cell to see the capacity math and what makes up the load.
3. **What can we do about it?** Each heat map cell's drawer has **recommendations**: reassignments that spread the load within a team, cross-team borrows within a project, and work to defer when nobody can take it. Every recommendation is the same short card: what to do, and the utilization before and after for the people it changes, with its evidence one click away. They're read-only: you make the changes in Linear.

Data sources, shown in the strip at the top of the app, each with its own **Sync** button:
- **Linear**, through the GraphQL API. By default the planner syncs one saved view, [GX capacity planning demo subset](https://linear.app/rideshare-company/view/gx-capacity-planning-demo-subset-30b9a718498a), with its teams, their members, cycles, projects and issue history (see [Which Linear issues are planned](#which-linear-issues-are-planned)).
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

4. Restart the app (`Ctrl+C`, then `npm run dev`). The Linear card switches to **Live** and names the view it syncs. Click **Sync** on the Linear card at any time to re-pull.

### Which Linear issues are planned

With an API key, the planner syncs the issues in one saved Linear **issue view**. The default is the GX capacity planning demo subset view:

```
https://linear.app/rideshare-company/view/gx-capacity-planning-demo-subset-30b9a718498a
```

- **Load and Data hygiene** come from the view's issues only, including completed ones (the view shows completed issues and sub-issues).
- **Capacity** counts the members of each team that has an issue in the view, except people with no planned work in any period in view (see [People with no planned work](#people-with-no-planned-work)).
- **Velocity** uses each person's completed issues in their teams' recent cycles, inside the view or not, because throughput isn't limited to the view.
- **Projects** are the ones the view's issues belong to.

To plan a different view, or the whole workspace, set `LINEAR_VIEW` in `.env` (a view URL, slug or ID, or `all`), then restart and **Sync**:

```bash
echo 'LINEAR_VIEW=https://linear.app/your-team/view/your-view-0123456789ab' >> .env
echo 'LINEAR_VIEW=all' >> .env   # whole workspace, as before
```

The API key must belong to the workspace that owns the view.

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

**OOO for the default view.** `samples/ooo-gx-capacity-demo.csv` is an OOO export for the people in the GX capacity planning demo view: vacations (some during Cycle 8, which started Oct 15), sick days, half-day training, and company holidays on Nov 26–27 and Dec 24–25. With an API key and the default view, the planner loads it automatically until you import your own CSV; the Workday card labels it **(sample)**. Demo mode keeps its own generated OOO data.

Import a CSV from the terminal:

```bash
# start from the template, or try a sample
cp samples/ooo-template.csv my-ooo.csv
npm run import:ooo -- samples/ooo-gx-capacity-demo.csv   # the default Linear view's people
npm run import:ooo -- samples/ooo-sample.csv             # the demo workspace's people

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
| **No estimate** | The team uses estimates and the issue has none | Left out of capacity (no load, no velocity) until it's estimated | Estimate it |
| **No project** | Not in a project | Shows as "No project" in the heat map's project view | Add it to a project |

The tab shows a card per flag, a table per team, and the flagged issues with an **Open in Linear ↗** link each. Click a card or a team to filter the list.

While any issue is flagged, a banner under the data strip says how many need cleanup, e.g. "⚠ 34 issues need cleanup in Linear: 12 have no date, 9 no estimate, 20 no project. Update them directly in Linear, then Sync." **Review** opens this tab. The banner can be dismissed for the browser session.

### Capacity heat map

*Who and which teams are over capacity, in which period, and why?*

- **Columns** are periods of *x* **weeks, months or quarters**: for example 2 weeks × 6, or 1 quarter × 4.
  - The first period starts on the **start date of the earliest cycle that still has open work**, even if that's in the past. In the default view that's FN Cycle 8, which started Oct 15. With no open cycle work, it starts today.
  - Week periods step on from there (2-week periods line up with 2-week cycles). Month and quarter periods end on calendar boundaries.
  - The column that contains today is marked **in progress**. It counts the **full period**: past days add to capacity, and work already done in the cycle adds to load (see [How capacity is calculated](#how-capacity-is-calculated)).
- **Utilization is always aggregate:** a person's whole load ÷ their whole plannable capacity. A person's capacity is never split between their teams.
- **Cells** show a big number with a small line beneath, tinted by status. A ring marks periods with OOO. Over-capacity cells add the gap in points ("+3.4 pts over"). **↔n** marks *n* suggested same-team reassignments, **⇄n** cross-team borrows, and **⚑** a cell still over capacity after them (with defer suggestions).
- **Individuals | Projects** toggle:
  - **Individuals** has two sections:
    - **Everyone:** one row per person with their overall utilization, most over first.
    - **By team:** each team row reads "people at X%": everything its members carry (on any team) plus the team's unassigned work, ÷ their combined plannable capacity. Beneath it, "N% on this team" is the team's own work as a share of that capacity. Under a team, each person shows their **overall** % (the same number as in Everyone) with "N% on this team" beneath: their work on this team ÷ their whole capacity. A person's shares across their teams add up to their overall %. People over capacity overall get a red edge and an "⚠ over overall" chip. People on several teams appear under each, with an "also on …" chip.
  - **Projects:** teams expand into their projects, plus "No project". A project cell reads "N pts · X%": the project's points on this team, and how loaded the people doing it are overall.
  - Cells say what's going on instead of a bare number when there is one:

    | Label | Meaning |
    |---|---|
    | **No work planned** | Nothing to do here this period (team rows add "people at X% elsewhere" when its members are busy on other teams) |
    | **All OOO · N pts** | Work planned, but every member is out |
    | **No capacity · N pts** | Work planned, but nobody on the team to do it |
    | **Unassigned · N pts** | (Projects) the work here has no assignee yet |
    | **Nothing planned** | No work and nobody to do it |
  - Groups start collapsed. Expand one with its ▸ toggle, or use **Expand all teams** / **Collapse all**. A collapsed team still says how many of its people are over capacity overall.
- **People with no planned work** in any period in view (0% in every column) are left out of the rows, team capacity and recommendations, so they don't drag team utilization down. A note above the table lists them by team. They come back as soon as they have assigned work in a period in view.
- **Filters** for projects, teams and people, plus **capacity type** (Over / At risk / Healthy / Under). The capacity type filter keeps a row when any period in view has that status, so you can go straight to the over-capacity rows. Any person, project or capacity type filter expands the groups while it's active.
- **Buffer %** (default 10%) is held back from every person's available capacity, for unplanned work, meetings and support. One value applies to everyone, and recommendations use it too.
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
    - what makes up the load: cycle work, work added mid-cycle, unscheduled work (spread to a due date or project target), and work done earlier in a cycle under way
    - the load broken down by team and by project
    - **How this is calculated** notes using this cell's numbers, e.g. "PLT-12 · 5 pts × 50% (In Progress) = 2.5 remaining"
    - **Recommendations** for this person in this period
    - every issue in the period, sorted by priority, with its status weight and the share of its points that falls in that period
  - **Team cell:** the members' capacity (baseline − OOO − buffer), what they carry (this team's work and their work on other teams), **recommendations** (the team's reassignments, borrows and defers, with one line for the team's share of what's still over), its members (overall % and % on this team) and its issues.
  - **Project cell:** the project's points and how loaded the people doing it are, **Teams on this project** (each team's project points, how loaded its people are, and its room up to 90%; a team "has room" at or under 90%), **recommendations** for this project's issues, including cross-team borrows and defers, who is doing the work, and its issues.
  - The **Members**, **Issues**, **Recommendations** and **Who is doing it** sections each have a ▾/▸ toggle to collapse or expand them. The browser remembers your choice.

### Recommendations (in the cell drawer)

*What can we change, and what needs a scope or timeline decision?*

Recommendations use the heat map's periods, buffer and velocity. They are suggestions only: make the changes in Linear, then **Sync**. They're worked out once for every period in view, then each drawer shows the ones for its person, team or project. A period that started in the past (the **in progress** column) is judged on its **remaining days**, since work already done can't be moved.

**Reassignments spread the load**, even when everyone ends up over capacity. For each period in order, and each person over plannable capacity (most over first), the planner moves their not-started issues (triage, backlog, todo), lowest priority first, to whoever ends up least loaded. A move is made only if it **narrows the gap** between the two people:

- **this period**, the gap between them shrinks by at least 1 pt, and the recipient ends within capacity or no more over it than the donor, and
- **across the issue's cycle** (or, with no cycle, the window its work is spread over), the recipient ends within capacity or no more over it than the donor.

**Relieving the current period comes first, judged on the cycle the work belongs to.** The cycle is the unit teams plan and commit in; heat map columns are a viewing choice. So a cycle whose last few days fall into the next column can still be moved to someone with room in that cycle, even if they're busy in the next column with other work, and changing the column size doesn't change what's suggested. Later overload isn't ignored: periods are handled in order, so the next period gets its own moves and defers.

Recipients who stay at or under **90%** ("has room") are preferred. Same-team moves come first; if none works, a **cross-team borrow** goes to someone on another team that works on the same project (teams with that project's work in view, plus the project's teams in Linear). Work already in progress or in review is never moved.

**Defers.** Whoever is still over after every move gets up to two **defer** cards: their lowest-priority not-started issues in the period, stopping once the overage is covered. If only started work is left, the card says to re-plan it instead. These are scope or timeline decisions for the lead; nothing is applied.

**Every recommendation is the same card**: a headline that names the action, a tag, one meta line, before → after for only the people it changes, at most one short note, and the evidence behind **Show evidence**.

```
Reassign PLT-250 to Ben Okafor                              Same team
API v2: pagination for list endpoints · 0.8 pts · Low · Todo
             Before      After
  Ana Ruiz   ▲ 214%  →   ▲ 190%
  Ben Okafor    34%  →      51%

Reassign RIDE-7153 to anthony                    ⇄ Cross-team borrow
Pet-friendly vehicle filter · 3 pts · Low · Todo
             Before      After
  sarah      ▲ 178%  →   ▲ 141%
  anthony       23%  →      57%
Needs agreement from Rider app and Rider Feedback Intake leads.

Defer RIDE-7160 to a later cycle                 ⚑ Scope or timeline
Pet carrier size guidance · 2 pts · Low · Todo
             Before      After
  Lauren     ▲ 141%  →   ▲ 124%
```

Notes, at most one per card: the borrow agreement note; "Both still over; a scope or timeline decision is needed too." when a move only spreads the load; "Still +N pts over after this." on a defer that doesn't cover the overage.

**Show evidence** on a card opens what the suggestion was built from:
- **Trigger:** the donor's load vs plannable capacity, e.g. "Ana in Oct 28 – Nov 1: 7.4 pts remaining load vs 3.4 pts plannable = 218% · over above 100%".
- **Checks:** same team (or works on the same project), narrows the gap this period, within capacity over the issue's cycle, and has room (≤ 90%), with each person's numbers. "Has room" shows as not met when the move only spreads the load.
- **Why this issue and this person:** its status and priority, and how the recipient was picked.
- **Inputs:** both people's velocity (and where it came from), working days, OOO days, buffer, plannable capacity and current load.
- **Source rows:** the Linear issue, and both people's OOO CSV rows (file and row number).
- **Freshness:** when Linear was last synced and when the OOO data was loaded.

A defer card's evidence adds **who could take it** (each teammate considered and the check that stopped them, e.g. "Tyler: would end 2.7 pts over in Platform Cycle 30"), how much of the person's work is already in progress (never moved), what deferring frees (this period and later), the team's projects driving the load, and who else on the team is still over.

**A team's share of what's left over.** The team drawer opens with one line, e.g. "Rider app is still +12.9 pts over this period after these moves." Each over-capacity person's excess is split across their teams by where their load is, plus any unassigned team work nobody has room for, so a person on three teams isn't counted three times.

---

## How capacity is calculated

Everything is in **estimate points**. Teams with estimates turned off count each issue as 1 point. Periods start at the earliest open issue's cycle, so the first one can start in the past; it counts the **full period** (capacity and load), while recommendations look only at its remaining days.

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
- **Done in cycle:** in a cycle under way, the work already done goes on its elapsed working days (cycle start to yesterday): completed issues at their full estimate, plus the done share of started issues (e.g. the other 50% of an In Progress issue). Each issue therefore counts its full estimate across the cycle. Canceled issues don't count.
- **Unscheduled work:** open issues with no cycle are spread from today to their **due date**, or else their project's **target date**. If that date has passed, they go on the current week. Issues with no date at all aren't load; they're flagged under Data hygiene.
- **Unestimated issues are left out** (no load, and they don't count toward velocity) until they're estimated; Data hygiene flags them. Teams with estimates turned off count each issue as 1 point.

<a id="people-with-no-planned-work"></a>**People with no planned work:** an active person with no load anywhere in the periods in view is left out of team capacity, the heat map rows and recommendations (they can't receive reassigned work). Counting them would make teams look emptier than they are. Someone with work in at least one period still counts in every period.

**Teams and projects, with no time split:**
- A person's utilization covers all their teams, and their capacity is never divided between them.
- A **team** is measured on its people as a whole: everything its members carry (on any team) plus the team's unassigned work, ÷ their combined plannable capacity. People on several teams count in full on each. "N% on this team" is the team's own work ÷ that capacity.
- A **project cell** is measured on the people doing that project's work on the team: everything they carry plus the project's unassigned work there, ÷ their plannable capacity.
- **Has room** = at or under 90%.

**Status:** under < 70% ≤ healthy ≤ 100% < at risk ≤ 115% < over. All thresholds are configurable.

---

## Linear API limits

Linear caps every GraphQL query at **10,000 complexity points**, separately from the hourly budget (3,000,000 points for a personal API key). Complexity is scored from the page sizes a query *requests*, not the data it returns, so a small workspace can still hit the cap. The planner keeps each query to one large page and fetches nested lists, such as each team's members, in their own paginated queries. The largest query is about 2,600 points, and the view's issue query about the same. `npm test` estimates every query and fails if one goes over 5,000.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API server on `127.0.0.1:4000` plus the UI on `127.0.0.1:5173` (hot reload) |
| `npm run build && npm start` | Production build, served from `http://127.0.0.1:4000` |
| `npm run check:linear` | Verify `LINEAR_API_KEY`, show which view is synced, and summarise what a sync would pull (view issues, teams, cycles, projects) |
| `npm run import:ooo -- <file.csv> [--dry-run]` | Validate and import an OOO CSV |
| `npm test` | Unit tests (capacity engine, periods, data hygiene, reassignments and evidence, view sync, CSV parsing, query complexity) |
| `npm run typecheck` | TypeScript across server, client and tests |

Local state lives in `data/` (gitignored):

| File | Contents |
|---|---|
| `snapshot.json` | Last Linear sync (re-pulled when `LINEAR_VIEW` changes) |
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
  reassign.ts         reassignments, borrows, defers and team overflow shares
server/        Express API (binds to 127.0.0.1 only)
  linear/             GraphQL client (pagination, rate-limit retries), queries, view config (view.ts), normalisation
  ooo/csv.ts          CSV parse/validate/diff/export
  demo/               demo workspace generator
  service.ts          sync and snapshot loading
scripts/       check-linear.ts, import-ooo.ts
client/        Vite + React UI
samples/       ooo-gx-capacity-demo.csv (the default Linear view's people), ooo-sample.csv (the demo workspace), ooo-template.csv
tests/         Vitest
```
