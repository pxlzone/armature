---
name: armature-docs
description: Write a document (plan, decision, guide, runbook, review, research) as part of the architecture model, or tie existing Markdown documents to it. Use when asked to write, update or move documentation, when a document is reported as not tied to the model or has broken references, or when migrating a docs/ folder.
---

# Documents in the model

Read the `armature-language` skill first for the file format.

A document is prose for people and agents. The model holds the structure; a document holds the reasons, the steps and the history. It belongs to the model through its header and its references, and `armature check` keeps both true.

## Format

```markdown
---
kind: decision          # plan | decision | guide | runbook | review | research | note
about: [api.server, data.postgres#orders, Order]
change: refunds         # plans only: the change this document explains
---
# No queue between the API and billing

The [[api.server]] calls [[billing#refund]] directly and passes an [[Order]].
```

- `about` and `[[references]]` take a node (`api.server`, or its last segment when unique), `node#interface`, a `Shape` or `Shape.field`, `node:requirement`, a flow id or a change id. `[[ref|shown text]]` sets the words shown.
- Use a reference the first time a part of the system is named in a section. Do not wrap every mention.
- A reference inside code (backticks or a fenced block) is left alone.
- New documents go in the documents folder: `armature/docs/`, or the folder that `docs:` in `armature/system.yaml` names (`armature orient` says which). In `armature/docs/`, use a folder per kind: `plans/`, `decisions/`, `guides/`, `runbooks/`, `reviews/`, `research/`. In a repo's own folder, follow the layout and naming already there. A README inside a package stays where it is.
- Every Markdown file in the documents folder needs a `kind`.

## Kinds

| Kind | Holds | Named |
|---|---|---|
| `plan` | Why a change is made and how: goal, approach, options rejected, open questions. Needs `change:` | the change id |
| `decision` | One choice and its reasons. Never rewritten: a new decision replaces it and says so | what was decided |
| `guide` | How a part works, or how to work on it | the part |
| `runbook` | Steps to operate something: deploy, restore, switch a domain | the task |
| `review` | A dated audit and its findings. Open findings also go in the node's `todos:` | the subject and date |
| `research` | Background that informed the work | the question |
| `note` | Anything else worth keeping | the topic |

## What stays out of a document

Facts the model holds or computes are written once, in the model:

- Status ("built", "phase 2 of 5", "not started"). It is computed from the change. Remove any `Status:` line.
- Lists of services, tables, queues and who calls whom. Link to the node instead: `[[worker]]`.
- Rules for editing a part of the code. They go in the node's `rules:`.
- Follow-ups and tech debt. They go in the node's `todos:`.

Keep in the document what the model cannot say: why, what was tried, what was rejected, how to operate it.

## Write a new document

1. Run `armature docs <ref>` for the part it is about. Update an existing document if one covers the subject.
2. Write the file in the documents folder (see Format) with the header and references.
3. Run `armature check`. Fix every `doc-reference` (a name not in the model) and `doc-header`.

## Tie existing documents to the model

1. Run `armature docs --loose`. It lists each document nothing ties to the model, with the nodes it mentions most.
2. For each one, read it and decide:
   - **It repeats the model** (a hand-drawn map, a list of services). Check that the model has everything in it, then delete it.
   - **It is a plan.** Add the header with `change:`. If no change exists for work that is still open, create one (`armature-design` skill). If the work is finished and has no change, use `kind: decision` or `kind: guide` for what is still worth knowing. Remove the `Status:` line.
   - **It mixes facts and reasons.** Move rules to `rules:`, follow-ups to `todos:`, then add the header to what remains.
   - **It is a runbook, review or research.** Add the header.
3. Replace the first mention of each part of the system with a `[[reference]]`.
4. Leave the file where it is unless the person asked to move it. A document joins the model through its header, not its folder.
5. Run `armature check` until no `doc-reference`, `doc-header`, `typed-status` or `loose-doc` remains for the files you touched.

Report what you deleted and why. Never delete a document on the strength of a model that `armature check` reports as wrong.

## When code changes

`armature impact <ref>` lists the documents that name a node, interface or shape. Update them in the same change. When you rename or remove a part of the model, `armature check` reports every document that still names it.
