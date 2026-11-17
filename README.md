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
- **A planning gate.** New work starts as a change in the model. Claude Code hooks send back plans and new files that go around it, and approving a change stays with a person.
- **Checks.** `armature check`, locally and in CI, says where the model and the code disagree: undeclared imports, tables and routes, stale data shapes, files no part owns, dead code, and documents that name something that no longer exists.

The language is specified in [SPEC.md](SPEC.md). This repo holds the tooling: the compiler and checker, the `armature` CLI, an MCP server, the viewer, and the Claude Code plugin with its skills and hooks. Version 0.1: it has been used on two private codebases, and it will change.

## Quick start

You need Node 22 or newer and Claude Code.

In Claude Code, add the plugin:

```
/plugin marketplace add pxlzone/armature
/plugin install armature@armature
```

The plugin brings the hooks, the skills and the MCP server, and puts `armature` on the PATH of Claude's Bash tool. To use `armature` in your own terminal as well:

```bash
git clone https://github.com/pxlzone/armature.git
cd armature && npm install && npm link
```

Then, in your project, start a model and ask Claude to fill it in:

```bash
armature init          # creates armature/ with an empty system.yaml
```

Ask Claude to document the repo (the `armature-document` skill), or to plan a feature before building it (`armature-design`). `armature view` opens the diagram at http://localhost:4747.

## Set up for a team

The tool ships as a Claude Code plugin, `armature`, from the marketplace in this repo (`.claude-plugin/marketplace.json`, plugin in `plugin/`). The plugin is self-contained: the CLI is bundled into one file with its dependencies, so a developer's machine needs only Node 22 or newer.

**Once per project repo** (one person, then commit):

```bash
armature install --team --marketplace pxlzone/armature
```

It writes only files meant to be committed, none naming a path on this machine:

| File | What it does |
|---|---|
| `.claude/settings.json` | Registers the marketplace (`extraKnownMarketplaces`) and enables `armature@armature` for everyone |
| `.claude/rules/armature-*.md` | Path-scoped rules generated from the model |
| `.github/workflows/architecture.yml` | CI: `armature check --annotate`, `armature sync-rules --check`, and the diagram as a build artifact |
| `armature/.gitignore` | Keeps `armature/.cache/` out of git |

It also removes what an earlier local `armature install` wrote (hooks in `settings.local.json`, the `.mcp.json` entry, copied skills), so nothing runs twice. `--ref` pins a tag or branch of the tool; `--no-ci` skips the workflow. If this repo is private, give CI a read-only token as the `ARMATURE_REPO_TOKEN` secret.

**Each developer:** open the repo in Claude Code, trust the folder, and accept the plugin install (or run `/plugin install armature@armature`). The plugin brings the hooks, the MCP server, the skills (as `/armature:armature-design` and so on), and puts `armature` on the PATH of Claude's Bash tool. Repos without `armature/` are left alone. To use `armature` in your own terminal too, run `npm install && npm link` in a clone of this repo.

**Releasing a new version:** change the code, bump `version` in `package.json`, run `npm run build:plugin`, and commit `plugin/` with the change. Teammates get it with `/plugin marketplace update`.

## Set up on one machine

```bash
npm install         # also builds (prepare script)
npm link            # puts armature on your path
armature install       # in a project: hooks, MCP server and skills with paths to this checkout
```

This is for working on the tool itself: the hooks point at this checkout, in `.claude/settings.local.json`, which is not shared.

## Use it in a project

```bash
armature init          # creates armature/ with an empty system.yaml
armature check         # errors and warnings; exits 1 on errors
armature view          # diagram at http://localhost:4747, reloads when armature/ changes
```

Once the plugin is on (or after `armature install`), restart the Claude Code session in that repo. From then on:

- the session starts with a digest of the system (`armature orient`);
- each node's rules load when the agent touches that node's files;
- an edit under `armature/` is checked at once, and errors go back to the agent;
- an edit to any document is checked too: a reference that names nothing in the model goes back to the agent;
- when code under a node changes and `armature/` does not, the agent is asked once to confirm the model and the documents about that node still hold;
- planning goes through the model (see "Planning gate" below);
- four workflows are available as skills: `/armature-document` (model an existing repo), `/armature-design` (plan a feature before building it), `/armature-docs` (write a document, or tie existing ones to the model), `/armature-audit` (repair drift).

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
| `armature drift [node]` | Tables, queues, routes and calls in the code that the model doesn't declare |
| `armature hotspots [node]` | Files that change most and are largest |
| `armature islands [node]` | Dead code: files no entry point (script, container command, route, test) reaches |
| `armature tech [id]` | The technologies in `armature/tech.yaml`, or who uses one |
| `armature shapes --sync` | Rewrite shape fields from Drizzle, Zod, Pydantic or SQL |
| `armature summarize --yes` | One-line file summaries by a model (costs money) |
| `armature index --watch` | Keep the index fresh while you work |

The MCP tools `context`, `search`, `callers`, `tests_for`, `drift`, `islands` and `tech` give agents the same.

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
| presents a plan from plan mode | sends it back unless it has a "Model change" section: what the work adds to the model, or "None" and why |
| creates a source file no node owns | refuses, and says how to place it: widen a node's `code:` globs, plan a node in a change, or add it to `ignore:` with a reason |
| creates a source file in a planned node | refuses while the node's change is `proposed` |
| sets a change to `approved` | asks you to confirm the edit: approval is yours |

Editing a file that exists is never refused, and tests, documents and configuration pass. `gate: off` in `armature/system.yaml` switches off everything but the approval question.

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

| Path | What it holds |
|---|---|
| `src/compile.ts` | Loads `armature/`, resolves references, computes status, runs the checks |
| `src/repo.ts` | Facts from the repo: files, git, source hashes, JUnit, lcov, pull requests |
| `src/render.ts` | Text answers: orient, show, where, impact, status |
| `src/code.ts` | Code index: tree-sitter symbols and imports, import resolution, file ranking |
| `src/docs.ts` | Documents: headers, references, titles, outlines, links to nodes |
| `src/gate.ts` | The planning gate: who owns a path, whether its change is approved, what a plan must contain |
| `src/context.ts` | Search, callers, tests, drift, hotspots, the context pack |
| `src/runtime.ts` | Run-time hints compared with declared links |
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
