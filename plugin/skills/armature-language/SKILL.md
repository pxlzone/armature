---
name: armature-language
description: Reference for the architecture model in armature/ (nodes, interfaces, shapes, links, flows, requirements, rules, changes, documents) and the armature CLI. Use whenever you read or edit any file under armature/, or need to know how the model maps to code.
---

# The architecture model in `armature/`

`armature/` describes this system once: its structure in YAML, and the documents about it in Markdown. People read it as a diagram (`armature view`); you read it with `armature` commands. You edit it with normal file tools, then run `armature check`.

This is how the repo plans, builds and documents. New work starts as a change in `armature/` (`armature-design` skill), and documents are tied to the model (`armature-docs` skill).

## Commands

| Command | Use it to |
|---|---|
| `armature orient` | Get the system digest. Already injected at session start |
| `armature show <ref> [--depth 2]` | Read one node, `node#interface`, `Shape`, `node:requirement`, flow or change |
| `armature where <file>` | Find the node that owns a file, with its rules |
| `armature impact <ref>` | See what depends on a node, interface or shape before changing it, and which documents name it |
| `armature map <node>` | List a node's files, most central first, with exported signatures. Read this before opening files |
| `armature map <file>` | See one file's symbols, what it imports and who imports it |
| `armature docs <ref>` | List the plans and written documents about a node, shape, flow or change before changing it. `--loose` lists documents not tied to the model yet |
| `armature symbol <name>` | Find where something is defined and who imports it |
| `armature deps [node]` | See which nodes' code imports which, and which of those the model does not declare |
| `armature check` | Validate after every edit under `armature/`. Fix all errors |
| `armature status` | Counts per status, changes with progress, todos |
| `armature activity [--days n]` | See where commits landed, per node and by Conventional Commits type |
| `armature todos [--kind debt]` | List tasks, tech debt and bugs noted on nodes, most urgent first |
| `armature confirm [Shape...]` | Record that a shape's fields match its source right now |

The same commands exist as MCP tools on the `armature` server.

## Files

```
armature/
  system.yaml          name, headline, actors, externals, system-wide rules, reports
  nodes/<id>.yaml      one node per file; a folder is a parent, defined by its _group.yaml
  shapes/*.yaml        named data shapes, several per file
  flows/<id>.yaml      ordered stories across links
  changes/<id>.yaml    planned work
  docs/<kind>s/*.md    documents: plans, decisions, guides, runbooks, reviews, research
                       (or a folder of the repo's own, named by docs: in system.yaml)
  tech.yaml            the technologies the system is made of
  shapes.lock.json     written by "armature confirm"; never edit by hand
```

Ids come from file and folder names. A node in `nodes/billing/ledger.yaml` has id `billing.ledger`.

## References

| Kind | Form | Example |
|---|---|---|
| Node | dotted path | `billing.ledger` |
| Interface | node `#` interface | `billing.worker#charge` |
| Shape | PascalCase | `ChargeJob` |
| Requirement | node `:` slug | `billing.ledger:no-double-entry` |
| Flow, change | slug | `checkout` |

A document names any of these as `[[billing.ledger]]`, `[[billing.worker#charge]]`, `[[ChargeJob]]`.

## Node file

```yaml
kind: worker            # actor app service worker job agent store queue external library group platform
role: records every payment         # five words or fewer; shown under the name
name: Ledger            # optional display name
description: One or two sentences.
tech: [node, tsx]
hub: true               # at most one per view; drawn as the wide card
code: [src/lib/ledger/**]          # globs that bind the node to files
docs: [docs/ledger-plan.md]   # optional: documents about this node, paths or globs
deploy: [ledger-worker]  # optional: compose services this node runs as
entry: [src/backfill.ts] # optional: files started by hand that no script or container names
unused: true            # only for dead code kept for reference: drawn grey, no links allowed
shared: false           # libraries only: a domain's own part, never hidden with shared libraries
scopes: [ledger]        # optional: Conventional Commits scopes that mean this node, when they differ from its id
tests: [tests/ledger.test.ts]
accepts:                # interfaces: how data gets in
  - id: run
    via: pgmq           # http grpc ws webhook mcp sql pgmq temporal kafka cron cli sdk smtp imap in-process
    route: POST /x      # or  queue: name
    takes: LedgerEntry
    gives: LedgerResult
calls:                  # request and response
  - to: payments#balance
sends:                  # one-way message or job
  - to: billing.worker#charge
reads:  [db#accounts]   # from a store
writes: [db#entries]    # to a store
rules:
  - Guidance for whoever edits this node's code.
requirements:
  - id: no-double-entry
    text: The same payment is never recorded twice.
    tests: tests/ledger.test.ts     # optional: the file whose tests prove it
    match: records a payment once   # optional: only tests whose title contains this
                                    # or tag a test title with [req billing.ledger:no-double-entry]
todos:
  - A short note about work to do.          # plain string: a task of medium priority
  - text: Currency rounding is duplicated in two modules.
    kind: debt          # task | debt | bug | idea
    priority: high      # high | medium | low
    owner: sam          # optional
    issue: 142          # optional GitHub issue number
change: some-change-id  # only while the node is planned work
```

Rules of thumb:

- Write each link in the file of the node whose code performs it. The tool draws the arrow the way the data moves.
- A link may carry `takes`, `gives` (calls) or `shape` (reads, writes) to override the interface's shapes, plus `note`, `via`, `change`.
- A store uses `holds:` in place of `accepts:`; each entry is a table: `{ id: orders, shape: Order }`.
- `to:` may be a bare node while a design is coarse. `armature check` warns until it names an interface.
- Small outside systems and people can be declared inline in `system.yaml` under `externals:` and `actors:`.
- A view holds at most 12 nodes. Past that, group nodes in a folder.

## Shapes

```yaml
ChargeJob:
  source: src/lib/queue.ts#chargeMessage   # optional pointer to the real schema
  fields:
    order_id: uuid
    amount: money
    trigger: enum(checkout|retry)
    coupons: string[]?
    retry: bool
    email: email @pii
```

Types: `string int float bool uuid timestamp date money email url json bytes`, any shape name, `T[]`, `T?`, `enum(a|b)`, `map<K,V>`. Tags such as `@pii` follow the type.

When a shape has a `source`, read that source, make the fields match it, then run `armature confirm <Shape>`. If the source later changes, the shape becomes stale until you repeat this.

## Flows

```yaml
headline: The order is stored first. The card is charged in the background.
trigger: Customer pays
steps:
  - customer -> web
  - web -> billing.worker#charge
  - step: db#orders -> billing.worker
    note: Reads the order it charges.
```

Every step is written the way the data moves and must match a declared link.

## Changes and status

```yaml
title: Refund an order from the admin page
state: approved        # proposed | approved | done | dropped
order: 4
doc: armature/docs/plans/refunds.md   # optional: a plan whose header says "change: <id>" is found without it
why: One or two sentences.
done_when:
  - A check a person can perform.
```

Tag planned elements with `change: <id>`. Tag elements being removed with `retire: <id>`.

Status is computed, never typed: planned (no file matches the code globs), building (files exist, change not done), built, verified (every requirement has a passing test), stale, failing, retiring.

Only a person moves a change from `proposed` to `approved`. Implement only approved changes. Set `state: done` when the work is finished; `armature check` refuses it while a node has no code or a requirement is unverified.

This is enforced before files are written:

- An edit that sets `state: approved` is put to the person to confirm.
- A new source file is refused when its node's change is still proposed.
- A new source file that no node owns is refused. Add it to a node's `code:` globs, plan a node for it, or list it under `ignore:` in `system.yaml` with a reason.
- In plan mode, a plan without a "Model change" section is sent back.

`gate: off` in `system.yaml` switches the last three off. Do not set it yourself.

## Documents

A document is a Markdown file with a header that ties it to the model:

```markdown
---
kind: plan              # plan | decision | guide | runbook | review | research | note
about: [billing.ledger, db#entries, LedgerEntry]
change: refunds         # plans only
---
# Title

The [[billing.ledger]] writes a [[LedgerEntry]] to [[db#entries]] for every refund.
```

- New documents go in the documents folder: `armature/docs/<kind>s/`, or the folder `docs:` in `system.yaml` names. Every Markdown file there needs a `kind`. A document anywhere else joins the model through the same header.
- `about` and `[[references]]` resolve like every other reference. One that names nothing is a `doc-reference` warning, so a rename shows which documents to fix.
- A plan's status is computed from its change. Never type a `Status:` line.
- Keep facts the model holds out of the prose: who calls whom, tables, rules, todos. Write why, how to operate it, and what was rejected.
- A document with no header that nothing names is `loose-doc`. `armature docs --loose` lists them.

The `armature-docs` skill has the kinds and the steps for tying existing documents to the model.

## Finding your way in the code

Start with `armature context "<the task in plain words>"` (or the MCP tool `context`): it names the parts of the system involved, their rules and plans, the data shapes, the most relevant files with signatures, what usually changes with them and which tests to run. Then `armature map <node>` or `armature search "<words>"` to look wider, `armature callers <symbol>` before changing a signature, and `armature tests <file|node|symbol>` for what to run. Read whole files only after that.

When `armature check` reports `runtime-drift`, the code reads a table, serves a route or calls something the model doesn't declare: run `armature drift <node>` and fix whichever side is wrong.

## Keeping the model true

When your code change adds, removes or alters an interface, a link between nodes, a data shape or a requirement, update `armature/` in the same change and run `armature check`. If nothing of that kind changed, leave `armature/` alone.

When what a document says stops being true, update the document in the same change. `armature impact <ref>` names the documents to look at.

## Todos and tech debt

When you notice tech debt, a bug or a follow-up task while working in a node's code and it is out of scope for the current task, add it to that node's `todos:` with the right `kind` instead of leaving a comment in the code. Remove a todo in the same change that resolves it.

## Commit messages

Write commit subjects and pull-request titles as Conventional Commits, with the node as the scope: `feat(billing.ledger): …` or, shorter, the last segment of its id: `fix(ledger): …`. The Activity view uses the scope and the changed files to show where work happens.

## Coverage, infrastructure and dead code

- Every file in the repo has a place: a node's `code`/`tests`, a technology's `files` in `armature/tech.yaml`, the document library (Markdown), a built-in skip (lockfiles, generated output), or `ignore: [{ path, why }]` in `system.yaml`. `armature orient` shows the coverage line; `unowned` warnings name the gaps.
- Third-party software the system runs itself (Temporal, LiteLLM, Caddy) is a `platform` node with `deploy:` naming its compose service. Databases stay `store` nodes.
- `armature islands` lists code no entry point reaches. Add hand-run scripts to `entry:`; move dead code you keep into an `unused: true` node; otherwise delete it. Never build on a file `armature islands` lists.
