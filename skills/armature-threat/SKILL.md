---
name: armature-threat
description: Threat-model a planned change in the architecture model before it is approved. Use when a change adds or alters an entry point (an interface people, outside systems or a browser or mobile app reach), sends tagged data such as @pii out of the system, needs a credential, or touches a protected node; when armature check reports no-auth, open-entry, data-leak, not-allowed, client-secret, undeclared-secret or no-security-requirement; or when asked to review the security of a design.
---

# Threat-model a change before approval

Read the `armature-language` skill first for the file format, and `armature-design` for how a change is planned.

The goal is not a document about threats. It is a model that says who may do what, so that `armature check` and the planning gate hold the code to it. Every answer below ends up as a field in `armature/`, a requirement with a test, or an open question for the person.

## 1. See what the change exposes

1. Run `armature surface <change>`. It lists the entry points the change adds or alters, with their auth and the sensitive data behind them, the tagged data it sends out of the system, and the secrets it holds.
2. Run `armature surface` for the whole system, and `armature impact <node>` on each node the change touches. "Must hold" lists the boundaries, allow-lists, data policy, secrets and rules already in force.
3. Check the model is complete enough to answer:
   - Code that runs on the user's device (a browser app, a mobile or desktop client) says `client: true`. Without it, nothing that client calls counts as an entry point.
   - Fields that carry personal data, credentials, payment details or anything regulated are tagged (`@pii`, `@secret`, or a tag of your own) in the shapes.
   - Outside systems are nodes of kind `external`, and links to them say what they carry.

## 2. Walk each entry point

For each entry point in the surface, answer and record:

| Question | Where the answer goes |
|---|---|
| Who may call it: anyone, a signed-in user, another service, an admin? | `auth:` on the interface (`none`, `user`, `service`, `admin`, or the scheme's name) |
| Is one node meant to be the only way in? | `only:` on the interface (or on a table: the only writers) |
| What may a caller see or change? Only their own records, their organisation's, anything? | A requirement of `kind: security` on the node, with `covers: [<interface>]`, written so a test can prove it: "A user's request for another user's order is refused." |
| What happens when the caller lies: a forged id, a replayed webhook, a request with someone else's token? | One security requirement per case that matters, each with a test |
| How much may a caller do: rate, size, cost? | A requirement, or a todo of kind `bug` if it is a known gap |

`auth: none` is a real answer for a public page or a health check, but not for anything that reaches sensitive data: the check refuses it.

## 3. Walk each movement of sensitive data

For each tagged field that leaves the system in the surface:

- Must it leave? If the outside system needs only an id, change the link's shape so the field stays home.
- If it must, add the destination to that tag's `leaves:` under `data:` in `armature/system.yaml`, with a `why:`. That edit asks the person: it is their decision.
- `@secret` never leaves, and never reaches a client.

## 4. Walk each credential

- List every credential the change needs under `secrets:` on the node that reads it, by environment variable name.
- No credential on a client node, and none with a prefix that ships it to the browser (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `EXPO_PUBLIC_`).
- Prefer one node holding a credential over several; if several must, say why in the plan document.

## 5. Protect what must not change by accident

If the change creates a node whose code is security-critical (authentication, payments, permissions, key handling), give it `protect: true`. Edits to its existing files then need an approved change that modifies it.

## 6. Finish

1. Run `armature check`. Fix every `open-entry`, `data-leak`, `not-allowed` and `client-secret` error, and every `no-auth` and `no-security-requirement` the change caused.
2. Run `armature surface <change>` again. This is what the person will see when asked to approve.
3. In the plan document, add a short section "Security" with what you decided and why, and every question you could not answer from the code or the request. Ask the person those questions; do not guess an answer to who may see whose data.

Never remove an `auth:`, an `only:`, a `never:`, `protect`, a requirement or a data policy to make a check pass. If one is wrong, say so and let the person change it.
