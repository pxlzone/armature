---
name: armature-design
description: Plan a new feature or a new system in the architecture model before writing code. Use when asked to plan, design or propose a feature, service or system, when in plan mode, or before implementing anything that adds a node, interface, link or data shape.
---

# Design in `armature/` before building

Read the `armature-language` skill first for the file format.

A plan in this repo is two files: a change in `armature/changes/<id>.yaml`, which says what is added to the model, and its plan document in the documents folder (step 5), which says why and how. Planned elements are drawn dashed in `armature view`, so the person reviews a diagram, not only text.

## Propose

1. Run `armature context "<the task>"`, then `armature impact` on every node, interface and shape the work will touch. It also lists the documents that name them.
2. Create `armature/changes/<id>.yaml` with `state: proposed`, a title, `why`, and `done_when` checks a person can perform.
3. Add the planned elements, each tagged `change: <id>`:
   - new nodes, with the `code` globs where their files will live;
   - new interfaces and links on existing nodes;
   - new shapes with their fields, and new fields on existing shapes;
   - a flow that tells the feature's story, also tagged with the change;
   - requirements stating the behaviour, written so a test can prove them.
4. Tag anything being removed with `retire: <id>` instead of deleting it.
5. Write the plan document in the documents folder: `armature/docs/plans/<id>.md`, or `<folder>/<id>-plan.md` when `docs:` in `armature/system.yaml` names the repo's own folder (`armature orient` says which):

   ```markdown
   ---
   kind: plan
   change: <id>
   ---
   # <Title>

   ## Goal
   ## Approach
   ## Options rejected
   ## Open questions
   ```

   Name parts of the model as `[[node.id]]`, `[[node#interface]]` and `[[Shape]]`. Do not type a status, and do not list the planned elements again: the change holds them.
6. Run `armature check` until it reports no errors.
7. Stop and ask the person to review it in `armature view` (Work lens, pick the change). Do not write code yet.

## In plan mode

Plan mode cannot write files, so the plan you present carries the proposal:

1. Do step 1 of "Propose" (read-only commands work in plan mode).
2. Give the plan a section headed **Model change** that lists the change id, the planned nodes with their `code` globs, interfaces, links, shapes, flows and requirements, and the plan document path. If the work changes none of these (a fix inside one node), write "None" and one line on why. A plan without this section is sent back.
3. Make writing those files the first step of the plan, before any code.
4. After the person approves the plan, write the change with `state: approved`. Claude Code asks the person to confirm that edit; that confirmation is the approval.

## Implement, after the person sets `state: approved`

Only a person approves a change. Never set `state: approved` because the work seems ready; the edit is put to the person. New source files are refused while their node's change is proposed, and when no node owns them.

1. Build the code where the `code` globs say it will live.
2. Write a test for each requirement and tag its title with `[req node:slug]`, or list the test file under the requirement's `tests:`.
3. Bind new shapes to their real schemas with `source:`, then run `armature confirm`.
4. Run the tests with a JUnit reporter into `armature/.cache/reports/`, then `armature status` to see what is verified.
5. When everything in the change is built and verified, set `state: done`, remove retired elements, and run `armature check`. It refuses `done` while a node has no code or a requirement is unverified.
6. Update the plan document if the approach changed while building, and any document `armature impact` listed.
7. Run `armature sync-rules`.

Keep the change small enough to review on one screen. Split it if the diagram needs more than a dozen new elements. A plan with phases is one change per phase, so each phase has its own computed status.
