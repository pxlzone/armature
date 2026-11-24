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
   - new shapes with their fields;
   - a flow that tells the feature's story, also tagged with the change;
   - requirements stating the behaviour, written so a test can prove them. Give a requirement about the whole story `covers: [<flow>]`.
   - for each new entry point (an interface an actor, an outside system or a client reaches): `auth:`, `only:` when one node should be the only caller, and a requirement of `kind: security` if it reaches sensitive data. New credentials go in `secrets:`; new outside destinations for tagged data go in `data:` in `system.yaml`. Run the `armature-threat` skill when the change adds any of these.
4. Tag what exists and will be altered with `modify: <id>`: a node that gets new behaviour, an interface whose data changes, a shape that gets a field (list the new field; it shows as planned). Do not use `change:` for these: it would draw something that is live as planned. Tag anything being removed with `retire: <id>` instead of deleting it.
   If the work must follow another change, add `after: [<that change>]` to the change file.
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
6. Run `armature check` until it reports no errors, and `armature surface <id>` to see what the change does to security. The person is shown the same summary when asked to approve, and approval is refused while the change has security errors.
7. Ask for approval once, when the whole proposal is finished: every element, the plan document, `armature check` clean and the security summary read. Do not stop between steps 1 to 6 to ask the person about parts of it; settle what you can from the code and the model, and put real open questions in the plan document. Then set `state: approved` as the last edit. Claude Code asks the person to confirm it, and the hook opens the change in `armature view` (Work lens) beside that prompt, so they approve a diagram, not a list. If they say no, change what they asked, finish the whole revision, and set `state: approved` again: one question per revision, never one per element. Do not write code before they confirm.

## In plan mode

Plan mode cannot write files, so the plan you present carries the proposal:

1. Do step 1 of "Propose" (read-only commands work in plan mode).
2. Give the plan a section headed **Model change** that lists the change id, the planned nodes with their `code` globs, interfaces, links, shapes, flows and requirements, and the plan document path. If the work changes none of these (a fix inside one node), write "None" and one line on why. A plan without this section is sent back; so is "None" without a reason, or beside steps that create source files no node owns.
3. Make writing those files the first step of the plan, before any code, and say the change is approved on its diagram once it is written. Keep the plan short: the person agrees to the direction here, and judges the design on the diagram.
4. After the person accepts the plan, write everything first without stopping: the planned elements, the plan document, and the change file with `state: proposed`. Run `armature check` until it is clean. Then set `state: approved` as the last edit. Claude Code asks the person to confirm that edit with the diagram open beside it; that confirmation is the approval, and it covers the elements the change holds at that moment. Writing `approved` before the elements exist approves nothing.

Plan mode cannot write the model, so it always has the plan question before the diagram one. For a single approval, propose outside plan mode (steps 1 to 7 of "Propose").

## Implement, after the person sets `state: approved`

Only a person approves a change, with `armature approve <id>` or by confirming your edit. Never set `state: approved` because the work seems ready, and never run `armature approve` yourself. New source files are refused while their node's change is proposed, and when no node owns them.

If the work turns out to need an element that was not approved (another node, another interface), add everything the work needs first, say so, and ask the person to approve the change again once, as in step 7 of "Propose". Until then `armature check` reports `scope-changed` and files in a newly added node are refused.

1. Build the code where the `code` globs say it will live.
2. Write a test for each requirement and tag its title with `[req node:slug]`, or list the test file under the requirement's `tests:`.
3. Bind new shapes to their real schemas with `source:`, then run `armature confirm`.
4. Run the tests with a JUnit reporter into `armature/.cache/reports/`, then `armature status` to see what is verified. Run them after your last code edit: a report older than the code does not count.
5. When everything in the change is built and verified, set `state: done`, remove retired elements and the `modify:` tags, and run `armature check`. It refuses `done` while a node has no code, an interface is missing from the code, or a requirement is unverified. A `done-unchecked` warning means nothing could prove the change: give it a requirement with a test.
6. Update the plan document if the approach changed while building, and any document `armature impact` listed.
7. Run `armature sync-rules`.

Keep the change small enough to review on one screen. Split it if the diagram needs more than a dozen new elements. A plan with phases is one change per phase, so each phase has its own computed status.
