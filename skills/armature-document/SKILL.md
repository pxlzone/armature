---
name: armature-document
description: Write the architecture model in armature/ for a repository that already has code. Use when asked to document, map or bootstrap the architecture of an existing project, or when armature/ is missing or covers only part of the repo.
---

# Document an existing repo in `armature/`

Read the `armature-language` skill first for the file format.

1. **Survey before writing.** Find every deployable unit (apps, services, workers, jobs), every data store and queue, and every outside system the code calls. Use build files, compose files, entry points and client modules as evidence. Do not model what you have not seen in the code.
2. **Run `armature init`** if `armature/` does not exist. Fill in `system.yaml`: name, a one-sentence headline, actors, and system-wide rules lifted from existing agent instructions.
3. **Write nodes coarsely first.** One file per unit with `kind`, `role` (five words or fewer) and `code` globs. Run `armature check`. Aim for no "unowned source files" warnings: every source file should fall under exactly one node.
   Then run `armature index` and `armature deps`: imports that cross node boundaries show where the boundaries are wrong or a link is missing.
4. **Group to fit the budget.** A view holds at most 12 nodes. Group by domain, not by technology, and give each group a role line. Put outside systems that serve one purpose in one group.
5. **Add interfaces and links.** For each unit, declare what it `accepts`, then its `calls`, `sends`, `reads` and `writes`, each in the file of the node whose code does it. A queue with a single consumer is an interface on that consumer (`via: pgmq`, `via: temporal`), not a node.
6. **Add shapes for the data that crosses nodes.** Point `source` at the real schema (`file#symbol`), copy the fields from it exactly, then run `armature confirm`. List only the tables and messages that matter to the flows.
7. **Write two or three flows** for the main user-visible stories, each with a headline that states the point of the flow.
8. **Record what is planned.** Turn roadmap items and plan documents into changes, and tag elements that do not exist yet with `change:`. A plan with phases becomes one change per phase.
9. **Tie the documents to the model.** Run `armature docs --loose` and follow the `armature-docs` skill: add a header (`kind`, `about`, `change`) to each document worth keeping, delete the ones the model now replaces, and move rules and follow-ups out of prose into `rules:` and `todos:`.
10. **Add requirements** for behaviour that tests already check, and link them with `tests:`.
11. **Finish.** `armature check` must report no errors. Run `armature sync-rules`. Tell the person to open `armature view` and review the diagram, and list anything you were unsure about.

Mark guesses as guesses in a `description` or a todo. A smaller model that is true beats a complete one that is not.
