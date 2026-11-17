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
| `armature show <ref> [--depth 2]` | Read one node, `node#interface`, `node~link`, `Shape`, `node:requirement`, flow or change |
| `armature where <file>` | Find the node that owns a file, with its rules |
| `armature impact <ref>` | See what depends on a node, interface, link or shape before changing it, what lies further along the data, and which documents name it |
| `armature path <node> <node>` | See how data gets from one node to another, step by step |
| `armature trace <Shape\|@pii>` | See where a shape or tagged data is held and where it leaves the system |
| `armature diff [git-ref]` | See what your branch changes in the model against a commit or branch |
| `armature rename <ref> <new>` | Rename or move a node, or rename an interface, link, requirement, shape, flow or change. It rewrites every reference: do not do this by hand |
| `armature map <node>` | List a node's files, most central first, with exported signatures. Read this before opening files |
| `armature map <file>` | See one file's symbols, what it imports and who imports it |
| `armature docs <ref>` | List the plans and written documents about a node, shape, flow or change before changing it. `--loose` lists documents not tied to the model yet |
| `armature symbol <name>` | Find where something is defined and who imports it |
| `armature deps [node]` | See which nodes' code imports which, and which of those the model does not declare |
| `armature check` | Validate after every edit under `armature/`. Fix all errors. `--only wrong` shows where the model disagrees with the code |
| `armature drift [node]` | See what the code does that the model does not declare, what the model declares that the code does not show, and which nodes could not be checked |
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
  approvals.lock.json  written by "armature approve"; never edit by hand
  baseline.json        written by "armature check --update-baseline"
```

Ids come from file and folder names. A node in `nodes/billing/ledger.yaml` has id `billing.ledger`.

## References

| Kind | Form | Example |
|---|---|---|
| Node | dotted path | `billing.ledger` |
| Interface | node `#` interface | `billing.worker#charge` |
| Link with an `id` | node `~` link | `billing.worker~refund-card` |
| Shape | PascalCase | `ChargeJob` |
| Requirement | node `:` slug | `billing.ledger:no-double-entry` |
| Flow, change | slug | `checkout` |

A document names any of these as `[[billing.ledger]]`, `[[billing.worker#charge]]`, `[[ChargeJob]]`.

A node can be written by its last segment when only one node ends with it. A name that is a node, a flow and a change at once (a change `refunds` that adds a node `refunds`) means the node; write the kind in front for the others: `flow:refunds`, `change:refunds`, also `node:` and `shape:`.

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
never:                  # nodes this one must not link to or import from; armature check fails when it does
  - to: web
    why: The ledger runs without the storefront.
accepts:                # interfaces: how data gets in
  - id: run
    via: pgmq           # http grpc ws webhook mcp sql bolt redis pgmq temporal kafka cron cli sdk smtp imap in-process
    route: POST /x      # or  queue: name
    takes: LedgerEntry
    gives: LedgerResult
calls:                  # request and response
  - to: payments#balance
    id: check-balance   # optional name, so a flow or a document can say billing.ledger~check-balance
sends:                  # one-way message or job
  - to: billing.worker#charge
reads:  [db#accounts]   # from a store; or an interface of a queue node, which means consuming from it
writes: [db#entries]    # to a store
rules:
  - Guidance for whoever edits this node's code.
requirements:
  - id: no-double-entry
    text: The same payment is never recorded twice.
    tests: tests/ledger.test.ts     # optional: the file whose tests prove it
    match: records a payment once   # optional: only tests whose title contains this
                                    # or tag a test title with [req billing.ledger:no-double-entry]
    covers: [checkout, db#entries]  # optional: the flow, interface, link or shape it is about
todos:
  - A short note about work to do.          # plain string: a task of medium priority
  - text: Currency rounding is duplicated in two modules.
    kind: debt          # task | debt | bug | idea
    priority: high      # high | medium | low
    owner: sam          # optional
    issue: 142          # optional GitHub issue number
change: some-change-id  # only while the node is planned work
modify: some-change-id  # the node exists and this change alters it
```

Rules of thumb:

- Write each link in the file of the node whose code performs it. The tool draws the arrow the way the data moves.
- A link may carry `takes`, `gives` (calls) or `shape` (reads, writes) to override the interface's shapes, plus `id`, `note`, `via`, `change`, `modify`, `retire`.
- Events: the publisher `sends` to an interface of a `queue` node; each consumer `reads` that interface in its own file. The publisher does not list its consumers.
- Each file belongs to one node. Two nodes that are not parent and child must not claim the same files (`overlap`); put shared code in a library node.
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

To plan a new field on a shape that is read from code, tag the shape `modify: <change>` and list the field. It shows as `@planned` until the code has it.

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

Every step is written the way the data moves and must match a declared link. Two more forms:

- The answer to a call: after `web -> api#checkout`, write `api#checkout -> web`. It matches the same `calls` link and carries what the interface gives.
- One named link: `- billing.worker~refund-card`. Use it when two links reach the same interface with different data.

## Changes and status

```yaml
title: Refund an order from the admin page
state: approved        # proposed | approved | done | dropped
order: 4
doc: armature/docs/plans/refunds.md   # optional: a plan whose header says "change: <id>" is found without it
why: One or two sentences.
after: [earlier-change]   # optional: changes that must be done first
done_when:
  - A check a person can perform.
```

Tag elements the change adds with `change: <id>`, elements that exist and that it alters with `modify: <id>`, and elements it removes with `retire: <id>`. Do not put `change:` on something that is already built: it would be drawn as planned.

Status is computed, never typed: planned (no file matches the code globs), building (files exist, change not done), built, verified (every requirement has a passing test), stale, failing, retiring.

Only a person moves a change from `proposed` to `approved`: they run `armature approve <id>`, or confirm your edit that sets it. Implement only approved changes. Set `state: done` when the work is finished; `armature check` refuses it while a node has no code, an interface is missing from the code, a change it comes `after` is not done, or a requirement fails or has no test in the current report.

An approval covers the elements the change had when it was approved. If you tag something new onto an approved change, `armature check` reports `scope-changed` and new files in that node are refused until the person approves it again. Say so and ask; never run `armature approve` yourself.

A requirement counts as verified only while the test report is newer than the code. After you change a node's code, run its tests again before you rely on "verified" or set a change to done.

This is enforced before files are written, whichever tool writes them, and for shell commands that create files:

- An edit that sets `state: approved`, or sets `done` on a change that was never approved, is put to the person to confirm.
- A new source file is refused when its node's change is still proposed, or when its node has no code yet and no approved change behind it.
- A new source file that no node owns is refused. Add it to a node's `code:` globs, plan a node for it, or list it under `ignore:` in `system.yaml` with a reason.
- In plan mode, a plan without a "Model change" section is sent back. "None" needs its reason, and is sent back when the plan creates files the model has no place for.

`gate: off` in `system.yaml` switches the refusals off. Do not set it yourself; that edit is put to the person too.

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
- `about` and `[[references]]` resolve like every other reference. One that names nothing is a `doc-reference` warning. `armature rename` rewrites references in documents when you rename something.
- A decision that replaces an earlier one says so in its header: `supersedes: <path or file name>`.
- A plan's status is computed from its change. Never type a `Status:` line.
- Keep facts the model holds out of the prose: who calls whom, tables, rules, todos. Write why, how to operate it, and what was rejected.
- A document with no header that nothing names is `loose-doc`. `armature docs --loose` lists them.

The `armature-docs` skill has the kinds and the steps for tying existing documents to the model.

## Finding your way in the code

Start with `armature context "<the task in plain words>"` (or the MCP tool `context`): it names the parts of the system involved, their rules and plans, the data shapes, the most relevant files with signatures, what usually changes with them and which tests to run. Then `armature map <node>` or `armature search "<words>"` to look wider, `armature callers <symbol>` before changing a signature, and `armature tests <file|node|symbol>` for what to run. Read whole files only after that.

When `armature check` reports `runtime-drift`, the code reads a table, serves a route or calls something the model doesn't declare: run `armature drift <node>` and fix whichever side is wrong. `not-in-code` is the reverse: the model declares a route or queue the node's code does not register.

`armature drift` ends by naming the nodes it could not check (a language or library the code index does not read). For those, no finding means nothing: read the code yourself before you trust their links and interfaces.

## Keeping the model true

When your code change adds, removes or alters an interface, a link between nodes, a data shape or a requirement, update `armature/` in the same change and run `armature check`. If nothing of that kind changed, leave `armature/` alone.

When what a document says stops being true, update the document in the same change. `armature impact <ref>` names the documents to look at.

A warning that is a false positive is not fixed by bending the model. Tell the person; they can accept it in `system.yaml` under `accept:` with a reason.

## Todos and tech debt

When you notice tech debt, a bug or a follow-up task while working in a node's code and it is out of scope for the current task, add it to that node's `todos:` with the right `kind` instead of leaving a comment in the code. Remove a todo in the same change that resolves it.

## Commit messages

Write commit subjects and pull-request titles as Conventional Commits, with the node as the scope: `feat(billing.ledger): …` or, shorter, the last segment of its id: `fix(ledger): …`. The Activity view uses the scope and the changed files to show where work happens.

## Coverage, infrastructure and dead code

- Every file in the repo has a place: a node's `code`/`tests`, a technology's `files` in `armature/tech.yaml`, the document library (Markdown), a built-in skip (lockfiles, generated output), or `ignore: [{ path, why }]` in `system.yaml`. `armature orient` shows the coverage line; `unowned` warnings name the gaps.
- Third-party software the system runs itself (Temporal, LiteLLM, Caddy) is a `platform` node with `deploy:` naming its compose service. Databases stay `store` nodes.
- `armature islands` lists code no entry point reaches. Add hand-run scripts to `entry:`; move dead code you keep into an `unused: true` node; otherwise delete it. Never build on a file `armature islands` lists.
