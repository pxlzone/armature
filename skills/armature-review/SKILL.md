---
name: armature-review
description: Review a pull request or branch against the architecture model in armature/. Use when asked to review a PR, a branch or a diff in a repo with an armature/ folder, or to check that code changes match the plan that was approved.
---

# Review a change against the model

Read the `armature-language` skill first for the file format.

A review here asks three things: did the model change in a way that weakens it, does the code match what was planned and approved, and does the code still match the model. Commands give the facts; your job is to read them against the diff.

## 1. What the model says changed

1. Find the base: the pull request's target branch (`gh pr view --json baseRefName`), or `main`.
2. Run `armature diff <base>`. Read the **Guards removed** section first. Each line is a boundary, `auth:`, `only:` list, `protect`, tag on a field, requirement or data policy that is gone; an `auth:` that changed to another scheme; or an `ignore:`, `accept:`, `auth: none`, allowed destination, name added to an `only:` list or `protect: false` inside a protected node that is new. Every one needs a reason in the pull request or the plan document; without one, it is the first finding.
3. Run `armature surface` and, for the change the branch builds, `armature surface <change>`. New entry points, data leaving the system and new secrets are the parts to read most carefully in the code.

## 2. Does the code match the plan

1. Find the change: `armature status` lists open changes; the branch's plan document names it. Read the plan with `armature docs <change>`.
2. `armature show <change>` lists the elements and whether what the person approved still matches (`scope-changed` if not). Code for elements outside the approval is a finding.
3. For each file the diff touches, `armature where <file>` names its node. A file in a node the change does not add or modify is either a missing `modify:` or work outside the plan.
4. Check each new requirement has a test, tagged `[req node:id]` or listed under `tests:`, and that the tests ran after the last code edit (`armature status`).

## 3. Does the code match the model

1. Run `armature check --only wrong` and `armature check --only errors`. With a baseline, `armature check --new` shows only what this branch added.
2. Run `armature drift <node>` for each node the diff touches: routes, tables, queues and calls the code has and the model does not.
3. For every entry point the change adds, read the handler: does it enforce the `auth:` the model declares, and does its test prove the security requirement? The model's `auth:` is a declaration; only the code and the test make it true.
4. For every credential: is it read only by the node that lists it, and never logged, returned or sent to a client?

## 4. Report

Group the findings: guards removed, work outside the approved change, security (entry points, data, secrets), model out of date, other. For each, give the file and line, what is wrong, and the smallest fix: a model edit, a test, or a code change. Say what you could not check, such as an entry point whose auth is enforced by infrastructure the repo does not contain.
