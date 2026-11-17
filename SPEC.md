# Armature: language spec (0.1)

Status: implemented in this repo. See [README.md](README.md) for how to run it. Written 2026-11-17.

The language and its tooling are called Armature: the frame a sculptor builds first and then fills in. The model folder is `armature/` and the CLI is `armature`. Before 2026-11-17 the tool was called Agent Brain, with the CLI `brain` and the folder `arch/`; a repo that still has `arch/` is read as it is, with a notice to rename it.

## 1. What this is

A small language for describing a software system once, in text files inside the project's repo, and reading it two ways:

- as an interactive diagram, for people;
- as compact, queryable context, for coding agents.

It has three jobs:

- **Document a system that exists.**
- **Design a system or feature before it is built**, then watch it fill in as it is built.
- **Hold the written documents about the system**: plans, decisions, guides, runbooks. They stay Markdown, and they are tied to the model so the tool can tell when one names something that no longer exists.

It is meant to be the standard way a project is planned, built and documented with coding agents: new work starts as a change in the model, and the tooling stops an agent that goes around it (section 9.4).

## 2. Decisions already made

| Topic | Choice |
|---|---|
| Audience | Our own projects first |
| Editing | The viewer is read-only. People ask the agent; the agent edits the files |
| Location | An `armature/` folder in each project repo. Tooling and viewer live in the Armature repo |
| Agent | Claude Code first |
| Planning | Through the model: a change, its planned elements and its plan document. Hooks enforce it |
| Documents | Markdown, tied to the model by a header and by references in the text |
| Visual style | Icon tiles, plain role lines, right-angle edges, dots moving along the active flow |

## 3. Principles

1. **Write intent by hand, compute the rest.** Status, test results, coverage and PR links are never typed.
2. **One model, many views.** Zoomed-out views are derived from leaf-level facts. Nobody maintains two levels.
3. **The tool detects, the agent repairs.** The tool finds what is out of date with cheap deterministic checks. An agent reads the code and fixes the model. This avoids a parser per language.
4. **Coarse first, precise later.** A link may point at a node before it points at an interface. A shape may list three fields before it is bound to source code.
5. **Every screen fits.** A view shows at most 12 nodes. Past that, nodes must be grouped.
6. **One fact, one home.** Structure is written in YAML and reasons in Markdown. A document links to the model and never repeats it.

## 4. Concepts

Nine concepts, four verbs.

| Concept | What it is |
|---|---|
| **Node** | A thing that holds or moves data. Nodes nest, which is what makes zoom possible |
| **Interface** | A named place on a node where data arrives or is kept: a route, a queue, a webhook, an MCP tool, a table |
| **Shape** | A named data structure with typed fields |
| **Link** | One node moving a shape to another node's interface |
| **Flow** | An ordered story across links, with a one-sentence headline |
| **Requirement** | A testable statement about a node, tied to tests |
| **Rule** | Guidance for whoever edits a node's code. Inherited by child nodes |
| **Change** | A planned piece of work that groups new, modified or retiring elements |
| **Document** | Prose about the system: a plan, decision, guide, runbook, review or research. Markdown with a header that ties it to the other eight |

**Node kinds** (closed set, each has an icon): `actor`, `app`, `service`, `worker`, `job`, `agent`, `store`, `queue`, `external`, `library`, `group`, `platform`.

Libraries are hidden on the map by default as shared plumbing. A library that is a domain's own part (a rendering engine, a pricing package) says `shared: false`; it and its children then always show.

`platform` is third-party software the system runs itself and depends on at run time: a workflow server (Temporal), a model gateway (LiteLLM), a web server (Caddy). A `store` is anything whose job is holding data, even when it is third-party (Postgres, Neo4j, Redis); an `external` is a service someone else runs (Anthropic, Stripe).

**Link verbs**, written from the point of view of the node whose code does it:

| Verb | Meaning | Data moves |
|---|---|---|
| `calls` | Request and response | To the target, then back |
| `sends` | One-way message or job | To the target |
| `reads` | Fetch from a store | From the store |
| `writes` | Put into a store | To the store |

The compiler turns every link into an edge that points the way the data moves.

## 5. File format

YAML, validated by JSON Schema. Folder nesting under `nodes/` is the hierarchy.

```
armature/
  system.yaml          name, headline, actors, externals, system-wide rules
  nodes/
    web.yaml
    billing.yaml
    shipping/          a group: its children are files in this folder
      _group.yaml
      label-printer.yaml
  shapes/              several shapes per file, grouped by topic
    billing.yaml
  flows/
    checkout.yaml
  changes/
    refunds.yaml
  docs/                documents, one folder per kind
    plans/
      refunds.md
    decisions/
  .cache/              derived facts, gitignored
```

### 5.1 References

| Kind | Form | Example |
|---|---|---|
| Node | dotted path | `shipping.label-printer` |
| Interface | node `#` interface | `billing#charge` |
| Shape | PascalCase, unique per system | `ChargeJob` |
| Requirement | node `:` slug | `billing:no-double-charge` |
| Change, flow | slug | `refunds` |
| Any of these, inside a document | double brackets | `[[billing#charge]]`, `[[ChargeJob]]` |

### 5.2 Node

The examples below describe a small web shop: a storefront, an API, a billing worker that charges cards, and a database.

```yaml
# armature/nodes/billing.yaml
id: billing
kind: worker
role: charges cards, issues refunds        # five words or fewer, shown under the name
tech: [node, tsx]
hub: true                                  # drawn as the wide card; one per view
code:  [src/billing/**, src/lib/payments/**]
scopes: [billing, payments]                # Conventional Commits scopes that mean this node
tests: [tests/billing.test.ts, tests/refunds.test.ts]

accepts:                                   # interfaces: how data gets in
  - id: charge
    via: pgmq
    takes: ChargeJob
    dlq: charge_dlq
  - id: refund
    via: pgmq
    takes: RefundJob
    change: refunds                        # planned

calls:
  - to: fraud#score
  - to: payments#charges
    takes: ChargeRequest                   # narrows a generic interface
    gives: ChargeResult
  - to: payments#refunds
    change: refunds                        # planned
reads:  [db#orders, db#customers]
writes: [db#payments, db#orders, db#ledger]

rules:
  - Use the payment sandbox when a credential is missing. Never call the live API from tests.

requirements:
  - id: no-double-charge
    text: A charge job retried after a timeout never charges the card twice.
    tests: tests/billing.test.ts           # optional: the file whose tests prove it
    match: never charges twice             # optional: only tests whose title contains this
  - id: refund-once
    text: An order is refunded at most once, however many times the button is pressed.
    change: refunds

todos:
  - Add retry with backoff to the fraud check.         # plain string: a task
  - text: Currency rounding is duplicated in two modules.
    kind: debt          # task | debt | bug | idea
    priority: high      # high | medium | low
    owner: sam
    issue: 142
```

Notes:

- `code` globs bind the node to files. This one field connects rules, tests, coverage and PRs to the diagram.
- `to:` may name just a node (`to: fraud`) while a design is still coarse. The checker warns, it does not fail.
- A store uses `holds:` instead of `accepts:`; each entry is a table or collection with a shape.
- `via` is an open list with known icons: `http`, `grpc`, `ws`, `webhook`, `mcp`, `sql`, `bolt`, `redis`, `pgmq`, `temporal`, `kafka`, `cron`, `cli`, `sdk`, `smtp`, `imap`.

### 5.3 Shape

```yaml
# armature/shapes/billing.yaml
ChargeJob:
  source: src/lib/queue.ts#chargeMessage   # optional pointer to the real schema
  fields:
    order_id: uuid
    amount: money
    attempt: int
    trigger: enum(checkout|retry)

RefundJob:
  fields:                                  # no source yet: still a draft
    order_id: uuid
    amount: money
    reason: string?
```

Types: `string`, `int`, `float`, `bool`, `uuid`, `timestamp`, `date`, `money`, `email`, `url`, `json`, `bytes`, any shape name.
Modifiers: `T[]` list, `T?` optional, `enum(a|b)`, `map<K,V>`.
Tags after the type mark sensitive data: `email: email @pii`.

`source` is a pointer for people and agents, plus a hash the tool stores. When the source text changes, the shape is flagged stale and an agent re-reads it.

### 5.4 Flow

```yaml
# armature/flows/checkout.yaml
id: checkout
headline: The order is stored first. The card is charged in the background.
trigger: Customer pays
steps:
  - customer -> web
  - web -> api
  - api -> db#orders
  - api -> billing#charge
  - db#orders -> billing
  - billing -> payments#charges
  - billing -> db#payments
  - step: db#payments -> web
    note: The customer sees the order as paid
```

A step with a note is written as `step:` plus `note:`.

Every step is written in the direction the data moves and must match a declared link.

### 5.5 Change

```yaml
# armature/changes/refunds.yaml
id: refunds
title: Refund an order from the admin page
state: approved          # proposed | approved | done | dropped
order: 4
doc: armature/docs/plans/refunds.md   # optional: a plan whose header names the change is found without it
issue: null              # optional GitHub issue number
done_when:
  - An operator can refund one order end to end on staging.
```

Elements join a change with `change: <id>`. Elements leaving the system carry `retire: <id>`.

- `proposed` to `approved` is a human decision. Agents implement only approved changes. An agent's edit that sets `approved` is put to the person to confirm (section 9.4).
- `done` is set by the agent and enforced by the checker: it is refused while any element of the change has no code or any of its requirements is unverified.
- A plan with phases is one change per phase, so each phase has its own computed status.

### 5.6 Document

```markdown
<!-- armature/docs/plans/refunds.md -->
---
kind: plan
change: refunds
about: [billing, db#refunds]
---
# Refund an order from the admin page

The [[billing]] worker takes a [[RefundJob]] from [[billing#refund]] and records each refund in
[[db#refunds]]. The customer hears about it from [[email|the email worker]].
```

| Header key | Meaning |
|---|---|
| `kind` | `plan`, `decision`, `guide`, `runbook`, `review`, `research` or `note`. A closed set, like node kinds |
| `about` | References to what the document is about: nodes, interfaces, shapes, requirements, flows, changes |
| `change` | For plans: the change, or changes, this document explains |

Other header keys are allowed and ignored.

- **References in the text.** `[[ref]]` names a node (full id, or its last segment when unique), `node#interface`, a `Shape` or `Shape.field`, `node:requirement`, a flow or a change. `[[ref|words]]` sets the words shown. They resolve like every other reference in the model; text inside code is left alone.
- **Where documents live.** New ones go in the documents folder: `armature/docs/` by default, one folder per kind. A repo whose documents already have a home names it with `docs:` in `system.yaml` (`docs: docs`); new plans then go beside the others as `<folder>/<id>-plan.md`. Every Markdown file in the documents folder is a model document and needs a `kind`. A document anywhere else in the repo (a package README) joins the model by carrying the same header, so nothing has to move.
- **What a document holds.** Why, how to operate, what was tried and rejected. Not status, not lists of services or tables, not rules for editing code, not follow-ups: the model holds those (`rules:`, `todos:`, computed status).
- **Decisions.** A `decision` records one choice and its reasons. It is not rewritten when the choice changes; a new decision replaces it and says so.

## 6. Status

Computed for every node, first match wins.

| Status | Rule | Drawn as |
|---|---|---|
| **Retiring** | Carries `retire` | Faded, name struck through |
| **Failing** | A linked test failed in the latest report | Red border |
| **Stale** | A bound shape's source changed, or a `code` glob matches nothing | Amber border, `≠` badge |
| **Planned** | No file matches its `code` globs | Dashed border |
| **Building** | Files exist, and it belongs to a change that is not done | Dashed border, progress dot |
| **Verified** | Files exist and every requirement has a passing test | Solid border, check badge |
| **Built** | Anything else | Thin solid border |

Links and interfaces are planned while they carry a change that is not done or either end is planned. Otherwise they are built.

### 6.1 Where the facts come from

| Fact | Source |
|---|---|
| Files per node | `code` and `tests` globs against the working tree |
| Test results | JUnit XML |
| Coverage | lcov, rolled up per node through `code` globs |
| Requirement to test | `tests:` (file) and `match:` (text in the test title) on the requirement, or a tag in the test title: `[req worker:skips-suppressed]` |
| Stale shapes | Hash of the `source` text, stored in `armature/shapes.lock.json` by `armature confirm` |
| Unowned files | Source files that match no node's globs |
| Commits per node | `git log`, matched by changed paths and by Conventional Commits scope |
| PRs per node | `gh` data, matched by changed paths and by the scope in the PR title. Optional |
| Issues | `issue:` on a change. Optional |

GitHub is optional. A repo with no remote still gets everything except the PR and issue badges.

### 6.2 Activity and Conventional Commits

Commit subjects and pull-request titles are read as [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope)!: description`.

- An item counts for a node when it changed a file the node owns, or when its scope names the node.
- A scope names a node when it equals the node's id, the last segment of its id, or an entry in the node's `scopes:` list.
- A parent counts everything its children count.
- Types (`feat`, `fix`, `docs`, …) are kept, so the view can show where features land and where fixes pile up.
- Scopes that match no node are reported, so they can be claimed with `scopes:` or left alone (`ci`, `deps`).
- The window is 90 days by default (`activity_days:` in `system.yaml`, or `--days`).

### 6.3 Code graph

`armature index` parses every source file with tree-sitter (TypeScript, TSX, JavaScript, Python) and records its top-level symbols with one-line signatures and doc comments, and what it imports. Imports are resolved to files in the repo: relative paths, `tsconfig` path aliases, workspace packages and Python modules. The index lives in `armature/.cache/code-index.json`; unchanged files are not re-read.

The index is tied to the model through file ownership (`code:` globs):

- **Code map per node.** Its files ranked by how central they are in the import graph, each with the signatures of what it exports, no bodies. This is what an agent reads to decide which files to open.
- **Symbol lookup.** Where a symbol is defined, its signature, its node, and which files and nodes import it.
- **Node-to-node dependencies.** Every import that crosses a node boundary, classified as *declared* (the model has a link between the two nodes), *library* (the target is shared code), or *undeclared*.
- **A check.** An undeclared dependency is a warning: declare the link, move the shared code to a library node, or fix the globs. This is the code-level drift detection the first version lacked.

The index also records, per file:

- **Uses of names:** every use of an imported or top-level name, with the enclosing top-level function and whether it is a call. This answers "who calls this" through named, aliased, namespace and re-exported imports. It is not type-aware: a method called on an object instance is not resolved.
- **Schemas:** Drizzle tables, Zod objects (including `.extend`), Pydantic models, and SQL `CREATE TABLE` with every later `ALTER TABLE` in the migrations replayed onto it.
- **Run-time hints:** HTTP routes registered, `/api/...` paths in strings, Temporal task queues served and started, workflow starts, Drizzle and Supabase table access, and table names in SQL text.
- **Search terms,** weighted: path and names count more than comments, comments more than body text.

### 6.3.1 Shapes from code

A shape with a `source:` the index can read takes its fields from the code; the model file's own list is only a fallback, and its tags (such as `@pii`) are kept. A model file that disagrees with the code is a warning, and `armature shapes --sync` rewrites it. Such shapes never go stale, so `armature confirm` is only needed for sources the index cannot read.

### 6.3.2 Run-time drift

Each node's run-time hints are compared with its declared links (on the node, its parents and its children):

| Seen in code | Declared when |
|---|---|
| Reads or writes table `t` | A `reads`/`writes` link to the store interface holding `t` |
| Starts work on queue `q`, or starts a workflow | A link to the interface with `queue: q`, or whose id is the workflow's name |
| Serves queue `q` | The node has an interface with `queue: q` |
| Calls `/api/...` | A link to the interface whose `route` ends with that path |
| Serves a route | The node has an interface whose `route` ends with that path |

Anything seen and not declared is a `runtime-drift` warning on the node. Declared table links never seen in the node's code are reported by `armature drift` but not warned about, since the access may go through shared code. Detected dependencies also appear in the Code view, marked by what they are (table, queue, HTTP, workflow).

### 6.3.3 History and tests

From the last 2,000 commits (commits touching more than 30 files are ignored as bulk edits): which files and which nodes usually change together, and each node's most changed files. From imports: which test files exercise each file, directly or through an index file.

### 6.3.4 Context for a task

`armature context "<task>"` ranks nodes and files for a task and renders, within a character budget: where the work lives (nodes with their most relevant rules, open plans and requirements, at most a third of the budget), the data shapes involved, the most relevant files with signatures only, files that usually change with them, tests to run, and related documents. The ranking combines BM25 over the search terms, the model's nodes, personalised PageRank over the import graph from the best matches, and co-change history. A hook adds this pack automatically on the first prompt of each session.

`armature eval retrieval` measures the ranking: each past commit with a descriptive Conventional Commits subject becomes a task, and the score is how many of the source files it changed appear in the top 5, 10 and 20. `armature eval agent` runs real sessions with and without the tooling in throwaway copies of the repo and compares tokens, turns, files read and whether a check command passes.

### 6.3.5 Summaries

`armature summarize` asks a model, through the `claude` CLI, for a one-sentence summary per file, cached by content hash. Summaries feed search, the context pack and the map. It costs money and sends code to the model provider, so it only runs with `--yes`.

### 6.4 Documents

Every Markdown file in the repo (outside `node_modules`, build output and `armature/.cache/`) is read into a document library: its title, kind, section outline, a summary, its length, and every part of the model it names. Each document is tied to nodes in three ways, strongest first:

| Link | When |
|---|---|
| **Declared** | The document's header (`about`, `change`) or a `[[reference]]` in its text names the node; or a node lists the document under `docs:`; or it is the `doc:` of a change that touches the node |
| **Inside its code** | The file sits under the node's `code:` globs, such as a package README or AGENTS.md |
| **Mentions its code** | The text names paths the node owns; the count says how often |

```yaml
# armature/nodes/billing.yaml
docs: [docs/billing/*.md, packages/billing/README.md]
```

A parent shows the documents of everything inside it.

Computed for every document:

| Fact | Rule |
|---|---|
| **Plan status** | From the changes it explains: state, nodes built, requirements verified. A `Status:` line typed into a plan is a warning (`typed-status`) |
| **Broken references** | A header entry or `[[reference]]` that resolves to nothing (`doc-reference`). Renaming or removing a node, interface or shape therefore lists the documents to fix |
| **Loose** | No header, no node lists it, no change names it, and it does not sit inside a node's code (`loose-doc`). READMEs, AGENTS.md and the like, and files in dot-folders, are never loose |

`armature impact <ref>` lists the documents that name a node, interface or shape, so an agent changing one knows which documents to update. `armature docs --loose` lists loose documents with the nodes each mentions most, as a starting point for `about:`.

### 6.5 Coverage, deployment, technologies and dead code

The model places every file in the repo, so it is a full copy of the project's shape:

| Where a file goes | How |
|---|---|
| A node | Its `code` or `tests` globs. Non-code files are fine: a store owns its migrations, a platform its configuration |
| A technology | `files:` on an entry in `armature/tech.yaml`: tooling such as `**/package.json` (pnpm), `**/Dockerfile*` (Docker), `.github/**` |
| The document library | Markdown, and anything under `docs/` |
| Built-in skip | Lockfiles, `generated/`, `*.gen.*`, build output, `armature/` itself |
| The ignore list | `ignore: [{ path, why }]` in `system.yaml`; an entry without a reason is a warning |

Anything else is `unowned` (incomplete). `armature orient` and the Checks panel give the share placed and the biggest gaps per top-level folder.

**Deployment.** Compose files (`docker-compose*.yml`, `compose*.yml`, or `compose:` globs in `system.yaml`) are read with the Dockerfiles they build. A node lists the services it runs as in `deploy:`; its panel then shows each service, environment (from the file name: `docker-compose.prod.yml` is `prod`) and image. A service no node claims is `undeployed` (incomplete); a node claiming a service no compose file defines is `deploy-missing` (wrong).

**Technologies.** `armature/tech.yaml` lists what the system is made of, each with an id, name, category (`runtime`, `framework`, `library`, `database`, `messaging`, `ai`, `protocol`, `tool`, `platform`), and optional url, version, note and `files`. Node `tech:` entries must name one of them (`unknown-tech`, incomplete). `armature tech [id]` lists them, or who uses one.

**Dead code.** A code file is alive when an entry point reaches it through imports. Entry points: tests; package.json `bin` and every file named in a `scripts` command (`tsx a.ts && tsx b.ts` counts both); `main` and `exports` of packages that are not private; container commands (compose `command`/`entrypoint` and Dockerfile `CMD`/`ENTRYPOINT`, matched inside the build context; `uvicorn main:app` names `main.py`); `<script src>` in HTML pages; files loaded by path (`workflowsPath`, `import.meta.glob`); Python files with a `__main__` block; framework and tooling conventions (file-based `routes/`, Next `app/` and `pages/`, configs, migrations, `scripts/`, `bin/`); and `entry:` globs on a node or in `system.yaml` for anything started by hand. A private workspace package's exports are not entry points: an export nobody imports is dead.

Dead files in a live node are a `dead-code` warning (incomplete). Dead code the team keeps goes in a node with `unused: true`: drawn grey and flat, never hidden with libraries, with no links (`unused-linked`, wrong) and no files an entry point reaches (`unused-reachable`, wrong). `armature islands [node]` lists dead files by node.

**Snapshot.** The compiled graph records the commit, branch, whether the working tree has uncommitted changes, and the time. The viewer's system panel and `armature orient` show it, so an export is a dated copy of the project.

## 7. Visual grammar

| Element | Drawing |
|---|---|
| Node | Rounded icon tile. Name in uppercase monospace. Role line beneath |
| Hub node | Wide card with the text inside. One per view |
| Kind | Icon. `tech` can swap in a brand icon (Postgres, Redis, Temporal) |
| Group | Colour, up to six hues. Red and amber are reserved for status |
| Status | Border style, as in section 6 |
| Link | Thin right-angle line, arrow pointing the way the data moves |
| Sync or async | Filled arrowhead for `calls`, open arrowhead for `sends` |
| Queue interface | Small queue glyph on the edge, not a separate node |
| Shape | Monospace label on the edge. Click for fields, source and status |
| Planned link | Dashed line |
| Active flow | Accent colour, dots travelling along the edge, both ends tinted |
| Headline | One sentence at the top of every view and every flow |

### 7.1 Zoom and navigation

1. **Levels.** System, then group, then service, then component. Components link to files; nothing below that is modelled.
2. **Zoom opens groups** (optional). Zooming into a stacked node opens it as a container around its children and fits it to the screen; zooming far out closes it again. Double-clicking, or pressing its plus, does the same without zooming. Several can be open at once. The zoom behaviour is off by default, so zooming only scales the map; "Zoom opens groups" in Settings turns it on. "Open as its own view" still drills in, with breadcrumbs back.
3. **Lifting.** A link between two leaves is drawn between their deepest visible ancestors. Parallel lifted links merge into one edge; expanding a node re-splits them.
4. **Ghosts.** In a drilled-in view, outside neighbours appear as faded tiles, so incoming and outgoing data stay visible.
5. **Budget.** At most 12 nodes per level, one hub, role lines of five words or fewer. The checker enforces this, which is what forces groups to exist.
6. **Gestures.** Two-finger scroll or drag pans. Pinch, or Ctrl/⌘ plus scroll, zooms toward the cursor; a mouse wheel zooms. Double-click the background to zoom in. Keys: `+` `-` zoom, `0` fit, arrows pan, Esc clears the selection. Zoom is clamped to 10–400%.
7. **Lines by zoom.** Zoomed out (below about 60%), links are merged for presentation: two-way links between a pair of nodes become one line with a head at each end, lines share trunks, the layout tightens, and labels show only on what is highlighted. Zoomed in (100% and above), every link is drawn on its own with its data label. The node under the cursor stays in place when the drawing switches. A control forces either mode. A selected flow is always drawn with separate lines.
8. **Nested containers.** Each open group is a container with a solid title bar in its colour. Nesting levels alternate between a tinted body and a near-white one, and inner borders are darker and slightly raised, so a container never blends into the one around it, even when they share a colour. When zoomed out, titles are drawn larger than their bar, up to 2.4 times, and the right side names the parents ("in Shipping › Label printer").
8. **Readable tiles.** Below about 70% zoom, tiles are drawn larger than their layout slot, up to 1.7 times, so names stay legible.
9. **Detail by zoom.** Below 50% the role lines, status tags and edge labels are hidden; names and status borders remain.

### 7.1.1 Planned versus built

- A built node is a filled tile with a solid border. A planned node is unfilled, dashed, with a muted icon and a "planned" tag. A node being built is hatched with a "building" tag. Status never relies on colour alone.
- The "With plans / Built today" switch removes every planned node and link, to show the system as it exists in the code.
- Picking a change in the Work lens lights up exactly what that change adds.

### 7.1.2 Plans and documents in the panel

Selecting a node, or opening a group, shows its plans first: every change that touches it or anything inside it, with its state, why, and done-when, and a button to read the plan document. Below come the documents about it and the documents that mention it. Any of them opens in a reader over the map: the full text rendered, its kind and computed plan status, its sections as a clickable outline, and the nodes, shapes, flows and changes it names as chips that jump to them. A `[[reference]]` in the text is a link to the thing it names: a node is selected on the map, a shape opens in the Data lens, a flow in the Flow lens, a change in the Work lens. One that names nothing is drawn struck through. Raw HTML in a document is shown as text, never run. A static export carries the document texts inside the file, up to 12 MB.

### 7.1.3 Highlight and motion

The header keeps only what is used all the time: the zoom path, the lenses, the headline, Expand all, the problem count and a **Settings** button. Every secondary option sits in the Settings popover, grouped as *What the map shows* (planned work, shared libraries, legend), *Lines and motion* (line merging, data motion) and *Navigation* (zoom opens groups, camera follows flow steps), each with a one-line explanation. Choices are remembered per browser; a dot on the button marks any setting that differs from the default, its tooltip names them, and Reset to defaults restores them. Escape or a click outside closes the popover.

- Hovering a node previews its neighbourhood: the node, its links and the nodes at their other ends stay; the rest dims to 15%. The hovered block itself lifts slightly, takes an accent glow and an accent title, so it stands apart from its neighbours. Group title bars behave the same way. Clicking keeps it and opens the details.
- Hovering a link highlights that link and the two blocks at its ends, with a soft glow under the line and its data label shown.
- Highlighted links are drawn above the others, thicker, with a filled label.
- **Data motion.** Dots travel along links in the direction the data goes: forward for `sends`, `writes` and `calls`, back from the store for `reads`, both ways for a `calls` that returns data and for a merged line that carries traffic both ways. Sync links carry round dots; async links (queues, events) carry short packets at a slower pace. Planned links never move, and the Code lens (imports, not data) does not animate. The mode is set in Settings:
  - **Off**: nothing moves.
  - **Active** (default): only links in focus move: what is hovered or selected, and the flow being played.
  - **All**: every built link moves, quietly in the line colour; links in focus keep their bright dots.
- Selecting a link, or stepping through a flow, shows a card on the canvas with the fields of the data that travels on it.
- During flow playback the camera follows the active step. This can be switched off.
- Moves take 240 ms and camera glides 400 ms with the easing `cubic-bezier(0.2, 0, 0.38, 0.9)`; things enter with a 200 ms fade. With reduced motion requested, only fades remain, data motion starts Off, and if switched on it runs at a quarter of the speed.

### 7.2 Lenses

One diagram, switchable overlays.

| Lens | Shows |
|---|---|
| **Structure** | Default. Status borders |
| **Flow** | Pick a flow and play it step by step |
| **Data** | Pick a shape or a field; every interface, link and store it touches lights up |
| **Tests** | Coverage ring and pass or fail per node; requirement list on click |
| **Work** | Pick a change; its elements light up. A list of next tasks, tech debt and bugs, filterable by kind and sorted by priority. Todo, debt and PR counts on nodes |
| **Docs** | The whole document library, grouped by folder and searchable, with each document's kind and filters for plans and documents not yet in the model. Picking a document opens it and lights up the nodes it is about; tiles show how many documents are about them |
| **Activity** | Commits and pull requests per node over the window, by Conventional Commits type. Busier tiles are darker; filter by type |
| **Code** | Replaces data links with what the code imports, node to node. Undeclared dependencies are red and dashed; the panel lists them with the importing files |
| **Rules** | Which nodes carry rules; click to read them with inherited ones |

## 8. Checks

`armature check` runs locally and in CI.

**Errors**

- Schema violation, duplicate id, or a reference that resolves to nothing.
- A flow step with no matching link.
- A view over the node budget.
- A `code` glob that matches nothing on a node that is not planned.
- A change marked `done` that is not.

**Warnings** never block. They fall in two groups, so the ones that matter are not buried under the ones that only ask for more detail:

- **Wrong: the model disagrees with the code.** Fix these first; until then, trust the code over the model. `runtime-drift` (tables, queues, workflows or routes the code uses and the model does not declare), `undeclared-import`, `shape-fields`, `stale-shape`, `source-symbol`, `verb` (reading or writing something that is not a store), `reference` and `type` (names that resolve to nothing), `no-test-match`, `dropped`, `report` (an unreadable test or coverage report), `doc-reference` (a document names something that is not in the model), `doc-header` (a document in the documents folder with no kind, or an unknown one).
- **Incomplete: the model leaves something out.** `no-shape`, `no-requirement`, `no-code`, `coarse-link` (a link to a node, not an interface), `unowned` (files that belong to no node), `unconfirmed`, `empty-change`, `loose-doc` (documents nothing ties to the model), `typed-status` (a plan that types its own status), `legacy-folder` (the model is still in `arch/`).

`armature check` prints errors, then each group with its count, and ends with a split summary; `--only wrong` (or `incomplete`, `errors`) narrows the list. With `--annotate`, wrong warnings show on a pull request as warnings and incomplete ones as quieter notices. The session digest (`armature orient`) lists the wrong count under "Needs attention". The viewer's checks chip reads, for example, "53 wrong · 197 incomplete", and its panel groups findings by code with one line on what each code means. The meaning and group of every code live in one table, `WARNING_INFO` in `src/types.ts`.

## 9. Agent interface (Claude Code)

Agents edit the YAML with their normal file tools. The tooling only reads, checks and explains.

### 9.1 Commands, also exposed as MCP tools

| Command | Returns |
|---|---|
| `armature orient` | System digest under about 1,500 tokens: headline, nodes with role lines, flow headlines, open changes, failing and stale items |
| `armature show <ref> [--depth n]` | One node, interface, shape, flow or change in full. Depth is the agent's zoom |
| `armature where <file>` | The node that owns a file, with its rules, interfaces and requirements |
| `armature impact <ref>` | Everything that depends on a node, interface or shape, and the documents that name it |
| `armature map [node or file] [--budget n]` | Ranked files with exported signatures for a node, one file's symbols, imports and importers, or the whole repo |
| `armature symbol <name>` | Where a symbol is defined and who imports it |
| `armature deps [node]` | Which nodes import which, against the declared links |
| `armature docs [ref] [--loose]` | The plans and written documents about a node, shape, flow or change, or the whole library. `--loose` lists documents not tied to the model |
| `armature index [--watch]` | Builds or refreshes the code index; `--watch` keeps it fresh |
| `armature context "<task>"` | The context pack for a task |
| `armature search "<words>"` | Files ranked for some words |
| `armature callers <symbol>` | Every use of a symbol, with enclosing functions, nodes and tests |
| `armature tests <file\|node\|symbol>` | Test files that exercise it |
| `armature drift [node]` | Run-time behaviour against declared links |
| `armature hotspots [node]` | Files that change most and are largest |
| `armature shapes [--sync]` | Shapes against their code; rewrite them from code |
| `armature summarize [--yes]` | Model-written file summaries |
| `armature eval retrieval \| agent` | Measure whether the tooling helps |
| `armature check` | Errors and warnings from section 8 |
| `armature status` | Counts per status, per change |
| `armature todos [--kind debt]` | Tasks, tech debt and bugs noted on nodes, most urgent first |
| `armature activity [--days n] [--github]` | Commits and pull requests per node, by Conventional Commits type |
| `armature confirm [Shape...]` | Records that a shape's fields match its source now |
| `armature view` | Starts the local viewer with live reload |
| `armature export [file]` | Writes the diagram as one self-contained HTML file |
| `armature install --team` | Enables the `armature` plugin for the repo in `.claude/settings.json`, writes rule files and a CI workflow; all committed |
| `armature install` | Wires Claude Code on this machine only: hooks, MCP server, skills, rule files |

### 9.2 Wiring

- **Session start hook:** refreshes the code index, then injects `armature orient`, which also names the code-graph commands and says how this repo plans and documents.
- **Prompt hook:** adds `armature context` for the first prompt of each session. When the session is in plan mode, or the prompt asks for a plan or a design, it adds the planning steps once.
- **Before a write, and before a plan is presented:** the planning gate (section 9.4).
- **Generated rule files:** `armature sync-rules` writes one path-scoped rule file per node from its `code` globs and rules, so rules load when the agent touches matching files.
- **After editing `armature/`:** a hook runs `armature check` and feeds errors back.
- **After editing any document:** the hook feeds back its broken references and header problems, and says once when a new document is tied to nothing.
- **On stop:** if code under a node changed and `armature/` did not, a hook names the nodes and the documents about them, and asks the agent to confirm both still hold.
- **Viewer to agent:** clicking an element offers "Ask the agent", which copies a prompt carrying the element's reference.

For a team, the hooks, the MCP server and the skills come from the `armature` Claude Code plugin (`plugin/hooks/hooks.json`, `plugin/.mcp.json`, `plugin/skills/`), with every path given through `${CLAUDE_PLUGIN_ROOT}`. The repo commits only `.claude/settings.json` (marketplace and enabled plugin), the rule files `.claude/rules/armature-*.md`, and the CI workflow. CI fails on model errors and on rule files that no longer match the model (`armature sync-rules --check`), and shows warnings as annotations (`armature check --annotate`).

A local install (`armature install`, for working on the tool) writes hooks to `.claude/settings.local.json`, the MCP server to `.mcp.json` and skills to `.claude/skills/`, with paths to that checkout. `armature install --team` removes those again.

### 9.3 Workflows, shipped as skills

| Skill | Steps |
|---|---|
| **Document an existing repo** | Scan, draft nodes and links coarsely, group to fit the budget, human reviews in the viewer, refine shapes |
| **Design a system or feature** | Describe the goal, agent writes a change plus planned elements, human reviews the dashed diagram and approves, agent implements, statuses flip |
| **Audit** | Walk stale shapes, unowned files and nodes changed since the last audit; repair the model and the documents that name what changed |
| **Documents** | Write a document with its header and references; or walk the loose documents of a repo, delete what the model replaces, move rules and follow-ups into the model, and tie the rest to it |

### 9.4 The planning gate

Skills are advice: an agent follows them when it notices they apply. The gate is what makes the model the path every plan and every new part of the system takes. It runs as hooks before a tool call and reads only the YAML it needs.

| When | Rule | What happens |
|---|---|---|
| The agent leaves plan mode | The plan has a section headed "Model change": the change id, planned nodes with their `code:` globs, interfaces, links, shapes, flows, requirements and the plan document; or "None" with a reason | A plan without it is sent back to the agent with what to add |
| The agent creates a source file | Some node's `code:` or `tests:` globs own the path | Refused, with the three ways forward: widen a node's globs, plan a node in a change, or list the path under `ignore:` with a reason |
| The agent creates a source file in a planned node | The node's change is `approved` | Refused while the change is `proposed` or `dropped` |
| The agent sets a change to `approved` | Approval is the person's | Claude Code asks the person to confirm the edit |

Plan mode cannot write files, so there the plan text carries the proposal and writing the change is the first step after approval. Outside plan mode the agent writes the change as `proposed` with its plan document, and the person reviews the dashed diagram.

The gate looks only at new files: editing a file that exists is never refused. Tests, documents, configuration and anything a technology or the ignore list places pass. It stays out of the way while no node has `code:` globs, and `gate: off` in `system.yaml` switches off everything except the approval question.

## 10. Fit check

Before this version was written, the language was tried on two private codebases. What it found in them is not part of this spec; what they tested is:

| Case | What it tested |
|---|---|
| A large existing monorepo: several apps, a dozen background workers, several databases and a dozen outside services | Grouping to fit the budget, lifted links, platforms and deployment, a place for every file, dead code, and a library of a few hundred documents |
| A small product, partly built, with most of its roadmap planned | Changes in order, planned elements that fill in as they are built, and plans whose status is computed |

## 11. Not in this version

- Visual editing in the viewer.
- A minimap.
- A cross-project landscape view.
- Call-site and type-level analysis (the code graph covers definitions and imports).
- Automatic field extraction from Zod, Drizzle or SQL.
- Branching and error paths inside flows.
- Flagging a document as out of date because the code it describes changed (only broken references are detected).
- Moving or rewriting existing documents automatically: the tool lists them, an agent does the work.

## 12. Build order (all seven steps are done)

1. **Language core.** JSON Schemas, compiler, `check`, `orient`, `show`, `where`. Model a small, partly built product by hand as the first real model.
2. **Viewer.** System view, zoom with lifting and ghosts, status borders, flow playback, shape panel.
3. **Agent loop.** Skills, hooks, generated rule files. Plan one real change through it.
4. **Derived facts.** JUnit and lcov ingestion, stale shapes, unowned files, Tests lens.
5. **A large existing repo.** Bootstrap its model with the agent. This is the scale test for groups, lifting and the budget. Add the Work lens and PR badges.
6. **Data lens and static export.**
7. **Documents and the planning gate.** Documents as the ninth concept, with headers, references and their checks; hooks that route planning and new files through the model.

The small product goes first because it has about a dozen nodes and both built and planned parts.

## 13. Defaults chosen without asking

Say so if any is wrong.

- Zoom stops at components and links to files.
- Derived status is computed on demand and never committed.
- Work tracking leans on changes and plan docs. GitHub issues are optional extras.
- The tooling is written in TypeScript, like the projects it was first used on.
- New documents live under `armature/docs/` unless `docs:` names another folder; existing ones stay in place and join through their header. Nothing is moved for you. Moving a repo's documents can mean rewriting every comment in the code that names a document's path, so a repo with an established folder keeps it.
- The folder is named after the tool and is not hidden: it holds plans and decisions people read, and many search tools skip dot-folders. `docs/` was not taken over because most repos, and doc-site tools, already use it.
- A repo's `arch/` folder is never renamed for you. The tool reads it and says so (`legacy-folder`).
- References in documents use `[[double brackets]]`, and only where the name has no spaces.
- The planning gate is on by default once a model has code globs, and refuses new source files that no node owns.
- A plan made in plan mode needs a "Model change" section, even when the answer is "None".
- An agent may write `state: approved`, and the person confirms that edit; the tool does not check who typed it afterwards.
