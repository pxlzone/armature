---
name: armature-audit
description: Find and repair drift between the architecture model in armature/ and the code. Use when asked to audit, verify or refresh the architecture model, when armature check reports stale shapes or unowned files, or after a large refactor.
---

# Audit the model against the code

Read the `armature-language` skill first for the file format.

1. Run `armature check` and `armature status`. Work through the output in this order.
2. **Errors.** Fix every one. A dead code glob usually means files moved: find where they went and update the glob.
3. **Stale shapes.** For each, open the `source`, make the `fields` match it exactly, then run `armature confirm <Shape>`. Check `armature impact <Shape>` and update any interface whose meaning changed.
4. **Unowned source files.** Add each to the node it belongs to, or create a node when it is a new unit. Files that are not system code (generated, tooling) go in `ignore:` in `system.yaml`.
5. **Imports.** Run `armature deps`. For each undeclared dependency, decide which is true: a real link is missing (declare it), shared code sits in the wrong node (move its glob to a library node, using a `!` glob to exclude it from the other), or the import itself is a mistake. Report it rather than hide it.
6. **Links.** For each node with code, compare its `calls`, `sends`, `reads` and `writes` against what the code does: client modules, queue producers, SQL and ORM access, outbound HTTP. Add what is missing and remove what is gone.
7. **Interfaces.** Compare each node's `accepts` with its real routes, queue consumers and exported entry points.
8. **Changes.** Close changes whose work is finished (`state: done`), and mark abandoned ones `dropped` after removing their tags. Do not approve a proposed change; that is the person's decision.
9. **Documents.** Fix every `doc-reference` (a document names something renamed or removed: use the new name, or rewrite the passage if the part is gone) and `doc-header`. Remove hand-typed status lines (`typed-status`). For `loose-doc`, follow the `armature-docs` skill.
10. Run `armature check` again, then `armature sync-rules`.

Report what you changed and what you could not determine. Do not invent links you did not find in the code.
