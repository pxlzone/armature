# Armature

Describe a software system once, in text files inside its repo, and read it two ways: as an interactive diagram for people, and as compact, queryable context for coding agents.

Armature is a small architecture language and its tooling for [Claude Code](https://claude.com/claude-code). The model lives in an `armature/` folder next to the code: the parts of the system (apps, services, workers, stores, outside systems), the interfaces where data arrives, the data shapes that move between them, flows, requirements tied to tests, and planned changes. Documents stay Markdown and are tied to the same model. Status is never typed: what is planned, built, verified, stale or failing is computed from the code, the tests and git.

```yaml
# armature/nodes/billing.yaml
kind: worker
role: charges cards, issues refunds
code: [src/billing/**]
accepts:
  - id: charge
    via: pgmq
    takes: ChargeJob
calls:
  - to: payments#charges
writes: [db#payments]
requirements:
  - id: no-double-charge
    text: A charge job retried after a timeout never charges the card twice.
```

What you get:

- **A diagram.** `armature view` draws the model as a zoomable map: planned work dashed, flows you can play step by step, and lenses for data, tests, documents, activity and code.
- **Context for agents.** A digest of the system at the start of every session, `armature context "<task>"` for the parts, files, rules and tests a task touches, and an MCP server with the same answers.
- **A planning gate.** New work starts as a change in the model. Claude Code hooks send back plans and new files that go around it, approving a change stays with a person, and the approval records what was approved.
- **Checks.** `armature check`, locally and in CI, says where the model and the code disagree, in both directions: tables, routes and imports the model does not declare, interfaces the model declares and the code does not have, stale data shapes, files no part owns or two parts claim, boundaries that are crossed, dead code, and documents that name something that no longer exists. Where it could not look, it says so.
- **Tools for changing the model.** `armature diff` shows what a branch does to the architecture, `armature rename` renames or moves a part and rewrites every reference, and `armature approve` is how a person approves a change.

The language is specified in [SPEC.md](SPEC.md). This repo holds the tooling: the compiler and checker, the `armature` CLI, an MCP server, the viewer, and the Claude Code plugin with its skills and hooks. Version 0.1: it has been used on two private codebases, and it will change.

## Install

You need:

- **Node.js 22 or newer** and **git**.
- **Claude Code**, for the hooks, the skills and the MCP server.
- Optional: the GitHub CLI `gh`, for pull requests in the Activity view, and the `claude` CLI, for model-written file summaries and `armature eval agent`.

### 1. Add the plugin to Claude Code

Each developer does this once. In Claude Code:

```
/plugin marketplace add pxlzone/armature
/plugin install armature@armature
```

If Claude Code asks you to, run `/reload-plugins` or start a new session. From a terminal instead:

```bash
claude plugin marketplace add pxlzone/armature
claude plugin install armature@armature
```

The plugin brings:

- **hooks** that orient the agent at session start, check every edit to the model and to documents, and hold back plans, new files and shell commands that go around the model;
- **skills**: `/armature:armature-document`, `/armature:armature-design`, `/armature:armature-docs`, `/armature:armature-audit` and `/armature:armature-language`;
- **an MCP server**, `armature`, with the same answers as the command line;
- **the `armature` command on the PATH of Claude's Bash tool**, so the agent can run `armature check`.

In a repo without `armature/system.yaml`, every hook stays silent.

### 2. Put `armature` in your own terminal (optional)

The plugin's command is only on Claude's PATH. To run `armature view` or `armature check` yourself:

```bash
git clone https://github.com/pxlzone/armature.git
cd armature
npm install     # installs and builds, about 20 seconds
npm link        # puts armature on your PATH
armature help
```

If your shell then says `command not found: armature`, the folder npm links into is not on your PATH. `npm prefix -g` prints its parent: add its `bin` folder to your PATH.

### 3. Start a model in a project

```bash
cd your-project
armature init          # creates armature/ with an empty system.yaml
armature check         # errors and warnings; exits 1 on errors
armature view          # the diagram at http://localhost:4747, reloads when armature/ changes
```

Without step 2, ask Claude to run `armature init` for you. Then start a new Claude Code session in the project, so it opens with the model, and ask it to document the repo (`/armature:armature-document`) or to plan a feature before building it (`/armature:armature-design`).

### 4. Share it with the team

Once per project repo, after `armature init`:

```bash
armature install --team --marketplace pxlzone/armature
```

It writes only files meant to be committed, none naming a path on your machine:

| File | What it does |
|---|---|
| `.claude/settings.json` | Registers this marketplace (`extraKnownMarketplaces`) and enables `armature@armature` for the project |
| `.claude/rules/armature-*.md` | Path-scoped rules generated from the model; Claude Code loads them without the plugin |
| `.github/workflows/architecture.yml` | CI: `armature check --annotate`, `armature sync-rules --check`, what a pull request changes in the model (`armature diff`) in its summary, and the diagram as a build artifact |
| `armature/.gitignore` | Keeps `armature/.cache/` out of git |

Commit them. Each teammate then opens the repo in Claude Code, trusts the folder, and runs `/plugin install armature@armature` once, if Claude Code has not already installed it.

- `--no-ci` skips the workflow. `--ref <tag or branch>` pins the version of Armature that CI and the marketplace use.
- The workflow needs no secret while this repo is public. For a private fork, give CI a read-only token as the `ARMATURE_REPO_TOKEN` secret.
- The team install also removes what a local `armature install` wrote (see below), so nothing runs twice.

### Update

- **The plugin:** run `claude plugin update armature@armature` in a terminal, or open `/plugin`, go to the Marketplaces tab and choose Update marketplace. Then run `/reload-plugins`. `/plugin marketplace update armature` alone only refreshes the list.
- **The terminal command:** in your clone, `git pull && npm install`.

### Uninstall

- **The plugin:** `/plugin uninstall armature@armature`.
- **The terminal command:** `npm unlink -g armature`.
- **A project's model** is only files: delete `armature/`, `.claude/rules/armature-*.md`, and the `armature` entries in `.claude/settings.json`.

### Without the plugin

When you work on Armature itself, wire a project to your clone instead of the plugin:

```bash
armature install       # run in a project that has armature/
```

It writes hooks with paths to your clone in `.claude/settings.local.json`, copies the skills to `.claude/skills/`, writes the rule files, and registers the MCP server in `.mcp.json`. It leaves `.mcp.json` alone when that file is committed, because the entry would name a path on your machine. None of this is meant to be committed, and it should not run beside the plugin.

## What happens in a session

With the plugin on (or after `armature install`), a Claude Code session in a repo with a model:

- starts with a digest of the system (`armature orient`);
- loads each node's rules when the agent touches that node's files;
- checks every edit under `armature/` at once, and sends errors back to the agent;
- checks every edit to a document too: a reference that names nothing in the model goes back to the agent;
- when code under a node changes and `armature/` does not, asks the agent once to confirm that the model and the documents about that node still hold;
- routes planning through the model (see "Planning gate" below), for file edits and for shell commands that create files.

All commands: `armature help`. A model in `arch/`, the folder's earlier name, is still read; `armature check` asks you to rename it to `armature/`.

## Test results and coverage

Status such as "verified" comes from reports the tool reads from `armature/.cache/reports/`: JUnit XML (`*.xml`) and lcov (`*.info`). Other paths can be set under `reports:` in `armature/system.yaml`.

```bash
# Vitest
npx vitest run --reporter=junit --outputFile=armature/.cache/reports/junit.xml

# Node's test runner
node --test --test-reporter=junit --test-reporter-destination=armature/.cache/reports/junit.xml
```

A requirement is verified when a linked test passes. Link it with `tests:` (a test file), `match:` (text in the test title), or a `[req node:slug]` tag in the test title.

A pass counts only while the report is newer than the code it tested. Edit a node's code and its requirements go back to unverified until the tests run again (`outdated-report`). A failure stands until a newer run says otherwise.

The generated CI job runs no tests. It therefore does not fail a finished change for lacking a report: it reports `done-unchecked`. To have CI check requirements, run your tests into `armature/.cache/reports/` before `armature check`.

## Sharing a diagram

```bash
armature export architecture.html
```

writes one self-contained HTML file with the model embedded. It needs no server.

## Code graph

```bash
armature index
```

parses the source files (TypeScript, TSX, JavaScript, Python) and records each file's top-level symbols and imports. It takes a couple of seconds for a thousand files and well under a second after that, because unchanged files are skipped. The session-start hook and `armature view` refresh it automatically.

```bash
armature map billing
```

prints that node's files, most central first, with the signatures of what they export. `armature map <file>` shows one file's symbols, imports and importers; `armature symbol <name>` finds a definition and who imports it; `armature deps` lists imports that cross node boundaries and flags the ones the model does not declare.

Agents get the same through the MCP tools `code_map`, `find_symbol` and `code_deps`.

Going deeper:

| Command | What it answers |
|---|---|
| `armature context "<task>"` | Everything an agent needs to start a task, within a budget. Also added automatically on the first prompt of a session |
| `armature search "<words>"` | Which files are about something |
| `armature callers <symbol>` | Who uses a function, class or type, from which function, and which tests cover it |
| `armature tests <file\|node\|symbol>` | Which tests to run after a change |
| `armature drift [node]` | Tables, queues, routes and calls in the code that the model doesn't declare, interfaces and links the model declares that the code doesn't show, and the nodes it could not check |
| `armature path <node> <node>` | How data gets from one part to another, step by step |
| `armature trace <Shape\|@pii>` | Where a shape or tagged data is held, and which outside systems it leaves to |
| `armature impact <ref> [--depth n]` | What a change to a node, interface, link or shape touches, several links out |
| `armature hotspots [node]` | Files that change most and are largest |
| `armature islands [node]` | Dead code: files no entry point (script, container command, route, test) reaches |
| `armature tech [id]` | The technologies in `armature/tech.yaml`, or who uses one |
| `armature shapes --sync` | Rewrite shape fields from Drizzle, Zod, Pydantic or SQL |
| `armature summarize --yes` | One-line file summaries by a model (costs money) |
| `armature index --watch` | Keep the index fresh while you work |

The MCP tools `context`, `search`, `callers`, `tests_for`, `drift`, `path`, `trace`, `diff`, `hotspots`, `shapes`, `islands` and `tech` give agents the same.

## Keeping the model honest

**What is not checked is said to be unchecked.** The code index reads TypeScript, JavaScript, Python and SQL, and recognises a fixed set of things in them (routes registered on an app or router, Temporal queues, Drizzle and Supabase table access, SQL text, `/api/` paths). Every interface and link carries what it found: seen, not seen, or not checked. `armature drift` ends with the nodes it could not read, so a node in Go or one that uses another ORM is never taken for clean.

**Reviewing a pull request.**

```bash
armature diff origin/main
```

lists what the branch adds, changes and removes in the model: nodes, interfaces, links, shapes and their fields, flows, requirements and changes. The generated CI job writes it to the pull request's summary.

**Renaming.** An id is a file name, so a rename touches every file that refers to it.

```bash
armature rename billing payments.billing     # a node: the new name is its full id, so this also moves it
armature rename Order Purchase               # a shape
armature rename api#checkout place-order     # an interface; also node~link, node:requirement, flow:x, change:x
```

It rewrites the model, the lock files and the documents, and names the test titles that carry an old `[req …]` tag.

**Boundaries.** `never:` on a node lists the nodes it must not touch. A link to one, an import of its code, or one of its tables or routes used in the code is an error, not a warning.

**A large model.** Warnings never fail a check by themselves. To stop a model from getting worse without clearing hundreds of findings first:

```bash
armature check --update-baseline             # once; commit armature/baseline.json
```

```bash
armature check --new --fail-on wrong         # in CI: only findings that are not in the baseline, and fail on wrong ones
```

A finding the team has looked at and keeps goes under `accept:` in `armature/system.yaml`, with a reason. An entry that matches nothing any more is reported.

The model places every file in the repo (nodes, `armature/tech.yaml`, the document library, or an ignore entry with a reason), reads docker-compose files to tie containers to nodes (`deploy:`), and keeps dead code on the map as grey `unused` nodes. See SPEC.md section 6.5.

## Measuring it

```bash
armature eval retrieval --n 80
```

replays past commits as tasks and checks whether the ranking finds the files each commit changed. It is free and needs Conventional Commits subjects. On a large private monorepo, held-out commits gave 58% of the changed files in the top 5 against 52% for plain word counting, and 82% against 75% in the top 20.

```bash
armature eval agent tasks.yaml --yes
```

runs each task twice with real Claude Code sessions, once with the tooling and once without, in throwaway clones, and compares tokens, turns, files read and a check command. It needs the `claude` CLI on the path (or `ARMATURE_CLAUDE_BIN`) and costs money. A task file looks like:

```yaml
- id: refund-cents
  prompt: Store refund amounts in cents everywhere
  check: pnpm test --filter api
  maxTurns: 40
```

## Plans and documents

Documents are part of the language. A document is a Markdown file with a header that says what it is and what it is about, and it names parts of the model in its text:

```markdown
---
kind: plan              # plan | decision | guide | runbook | review | research | note
change: refunds
about: [billing#refund]
---
# Refunds

The [[billing]] worker takes a [[RefundRequest]] from [[api#refund]].
```

New documents go under `armature/docs/`, one folder per kind. A repo that already keeps its documents in a folder of its own names it in `armature/system.yaml` (`docs: docs`): the header check, the planning messages and the skills then use that folder, and new plans go beside the others as `<folder>/<id>-plan.md`. A document anywhere else joins the model by carrying the same header, so nothing has to move.

- References resolve like the rest of the model. Rename or remove a node, interface or shape, and `armature check` lists every document that still names it (`doc-reference`).
- A plan's status is computed from its change. A `Status:` line typed into a plan is a warning.
- `armature impact <ref>` lists the documents that name what you are about to change.
- `armature docs --loose` lists the documents nothing ties to the model yet, with the nodes each mentions most. That list is the migration backlog for an existing repo.

Every other Markdown file is still indexed and tied to nodes by where it sits and the code paths its text names. In the viewer, a node's panel lists its plans and documents and opens any of them in a reader, where each reference is a link to the thing it names; the Docs view shows the whole library. Agents use `armature docs <ref>` or the MCP tool `docs`.

## Planning gate

The skills describe how to plan. The gate makes sure it happens. It runs as Claude Code hooks, before a tool call:

| When the agent | The gate |
|---|---|
| presents a plan from plan mode | sends it back unless it has a "Model change" section: what the work adds to the model, or "None" and why. "None" beside steps that create files the model has no place for is sent back too |
| creates a source file no node owns | refuses, and says how to place it: widen a node's `code:` globs, plan a node in a change, or add it to `ignore:` with a reason |
| creates the first file of a node that has no code | refuses unless the node belongs to an approved change |
| creates a source file in a node a change adds or alters | refuses while the change is `proposed`, and when the node joined the change after it was approved |
| sets a change to `approved`, or to `done` without it ever being approved | asks you to confirm the edit: approval is yours |
| sets `gate: off`, or edits the approval record | asks you |
| runs a shell command that would do any of the above | does the same: it reads redirects, `tee`, `touch`, `cp`, `mv`, and writes to change files |

You approve a change by confirming the agent's edit, or yourself:

```bash
armature approve refunds
```

Either way `armature/approvals.lock.json` records who approved which elements. If the change grows afterwards, `armature check` reports `scope-changed` and the new part is not built until you approve again.

Editing a file that exists is never refused, and tests, documents and configuration pass. `gate: off` in `armature/system.yaml` switches off everything but the questions put to you.

A hook reads a command; it does not run a shell, so a script that writes files gets past it. What that leaves behind shows up in `armature check`, locally and in CI: `built-unapproved`, `scope-changed`, `unrecorded-approval`.

## Commits and pull requests

```bash
armature activity --github
```

lists commits and pull requests per node for the last 90 days, grouped by [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) type. An item counts for a node when it changed the node's files or when its scope names the node (`fix(billing): …`). Give a node `scopes: [name]` to claim a scope that differs from its id.

The viewer's Activity lens shows the same data on the map. Commits come from `git log`; pull requests need `--github`, the `gh` CLI and a git remote.

## Develop

```bash
npm test            # compiler and checker tests
npm run typecheck
npm run build       # CLI to dist/, viewer to viewer/dist/index.html
npm run build:plugin  # the plugin in plugin/: bundled CLI, viewer, skills, hooks, MCP server
```

To release a new version, change the code, bump `version` in `package.json`, run `npm run build:plugin`, and commit `plugin/` with the change. Users get it with `claude plugin update armature@armature`.

| Path | What it holds |
|---|---|
| `src/compile.ts` | Loads `armature/`, resolves references, computes status, runs the checks |
| `src/repo.ts` | Facts from the repo: files, git, source hashes, JUnit, lcov, pull requests |
| `src/render.ts` | Text answers: orient, show, where, impact, status |
| `src/code.ts` | Code index: tree-sitter symbols and imports, import resolution, file ranking |
| `src/docs.ts` | Documents: headers, references, titles, outlines, links to nodes |
| `src/gate.ts` | The planning gate: who owns a path, whether its change is approved, what a plan must contain, what a shell command would create |
| `src/approve.ts` | Approving a change and recording what was approved |
| `src/refs.ts` | The one resolver for references, shared by the compiler, the text answers and the viewer |
| `src/diff.ts` | The model now against the model at a git ref |
| `src/rename.ts` | Renaming a part of the model and rewriting every reference |
| `src/baseline.ts` | The warning baseline |
| `src/context.ts` | Search, callers, tests, drift, hotspots, the context pack |
| `src/runtime.ts` | Run-time hints compared with declared links, in both directions, and what could be checked at all |
| `src/schemas.ts` | Shapes read from Drizzle, Zod, Pydantic and SQL migrations |
| `src/history.ts` | Co-change and hotspots from git |
| `src/eval.ts` | Retrieval and live-agent evaluation |
| `src/summarize.ts` | Model-written file summaries |
| `src/codeview.ts` | Text answers from the code index: map, symbol, deps |
| `src/agent.ts` | Claude Code hooks, rule files, install |
| `src/mcp.ts` | MCP server |
| `src/server.ts` | Viewer server and static export |
| `viewer/` | The diagram (React, ELK layout) |
| `schemas/armature.schema.json` | JSON Schema for every model file |
| `skills/` | Skills, shipped in the plugin or copied by a local `armature install` |
| `scripts/build-plugin.mjs` | Builds `plugin/` (generated; commit it with each release) |
| `.claude-plugin/marketplace.json` | The marketplace teammates add |
