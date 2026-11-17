// What the model says about security, and what follows from it: the entry points of the system and
// who may use them, the sensitive data behind them, the data that leaves the system, and secrets.
//
// Pure functions over the compiled model, shared by the compiler (findings), the answers (surface,
// must-hold), the planning gate (the question put to the person on approval) and diff (guards).
// Everything here reads declarations. Whether the code enforces an `auth:` is not something the code
// index can see; a passing requirement of kind security is the proof.
import type { Change, DataPolicy, Edge, GNode, Interface, Problem, Requirement, Shape } from './types.js';

/** Environment variable names that hold a credential, by the usual naming. */
export const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL|(^|_)KEY$|(^|_)DSN$|DATABASE_URL$|CONNECTION_STRING$)/i;
/** Prefixes that bundlers copy into code shipped to the browser or the device. */
export const PUBLIC_ENV = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_|STORYBOOK_)/;
/** Tags that mark sensitive data even when system.yaml has no `data:` policy for them. */
export const DEFAULT_SENSITIVE = ['pii', 'secret'];

/** The part of the model the security checks read. A compiled Graph is one. */
export interface SecurityView {
  nodes: GNode[];
  edges: Edge[];
  shapes: Shape[];
  changes: Change[];
  system: { data: DataPolicy };
}

const inside = (id: string, anc: string): boolean => id === anc || id.startsWith(`${anc}.`);

/** Where data goes when it leaves: outside systems, and code on the user's device for secrets. */
const OUTSIDE = new Set(['external']);

/** Each tag and the policy for it. `secret` never leaves unless system.yaml lists where it may go. */
export function policyOf(v: SecurityView): DataPolicy {
  return { secret: { leaves: [] }, ...v.system.data };
}

export function sensitiveTags(v: SecurityView): Set<string> {
  return new Set([...DEFAULT_SENSITIVE, ...Object.keys(v.system.data)]);
}

/** Tag -> the fields that carry it, for a list of shapes, through every shape they embed. */
export type Tagged = Map<string, string[]>;

export function tagIndex(v: SecurityView): (shapes: string[]) => Tagged {
  const byId = new Map(v.shapes.map((s) => [s.id, s]));
  const memo = new Map<string, Tagged>();
  const ofShape = (id: string, trail: Set<string>): Tagged => {
    const hit = memo.get(id);
    if (hit) return hit;
    const out: Tagged = new Map();
    const s = byId.get(id);
    if (!s || trail.has(id)) return out;
    trail.add(id);
    const put = (tag: string, field: string): void => {
      const list = out.get(tag) ?? [];
      if (!list.includes(field)) list.push(field);
      out.set(tag, list);
    };
    for (const f of s.fields) {
      for (const t of f.tags) if (t !== 'planned') put(t, `${s.id}.${f.name}`);
      for (const m of f.type.matchAll(/[A-Z][A-Za-z0-9_]*/g)) {
        if (!byId.has(m[0]) || m[0] === id) continue;
        for (const [t, fields] of ofShape(m[0], trail)) for (const x of fields) put(t, x);
      }
    }
    trail.delete(id);
    memo.set(id, out);
    return out;
  };
  return (shapes) => {
    const out: Tagged = new Map();
    for (const s of shapes) for (const [t, fields] of ofShape(s, new Set())) out.set(t, [...new Set([...(out.get(t) ?? []), ...fields])]);
    return out;
  };
}

function merge(into: Tagged, from: Tagged): void {
  for (const [t, f] of from) into.set(t, [...new Set([...(into.get(t) ?? []), ...f])]);
}

/** Only the sensitive tags of a tag map. */
function sensitive(v: SecurityView, t: Tagged): Tagged {
  const keep = sensitiveTags(v);
  return new Map([...t].filter(([k]) => keep.has(k)));
}

export const tagList = (t: Tagged): string => [...t].map(([k, f]) => `@${k} (${f.slice(0, 3).join(', ')}${f.length > 3 ? ', …' : ''})`).join(', ');

/** Code that runs on the user's device: a browser app, a mobile or desktop client. Children inherit it. */
const isClient = (n: GNode | undefined): boolean => !!n?.client;
const isCaller = (n: GNode | undefined): boolean => !!n && (n.kind === 'actor' || n.kind === 'external' || n.client);

export interface EntryPoint {
  iface: Interface;
  node: GNode;
  /** The actors, outside systems and client nodes that link to it. */
  callers: string[];
  /** Sensitive data the interface takes or gives, or that its node reaches through its own links. */
  reaches: Tagged;
  /** Requirements of kind security that cover it: on its node with no `covers:`, or covering it. */
  requirements: Requirement[];
}

/**
 * Entry points: interfaces of server-side nodes that an actor, an outside system or a client links to.
 * Anyone who can reach those callers can reach the interface, so this is where `auth:` matters.
 */
export function entryPoints(v: SecurityView): EntryPoint[] {
  const nodes = new Map(v.nodes.map((n) => [n.id, n]));
  const tags = tagIndex(v);
  const reqs = v.nodes.flatMap((n) => n.requirements).filter((q) => q.kind === 'security');
  const out: EntryPoint[] = [];
  for (const n of v.nodes) {
    if (isCaller(n) || n.kind === 'store' || n.kind === 'queue') continue;
    for (const i of n.interfaces) {
      if (i.holds) continue;
      const callers = [...new Set(v.edges.filter((e) => e.iface === i.ref && (e.verb === 'calls' || e.verb === 'sends') && e.owner !== n.id && isCaller(nodes.get(e.owner))).map((e) => e.owner))];
      if (!callers.length) continue;
      const reaches = sensitive(v, tags([...i.takes, ...i.gives]));
      merge(reaches, sensitive(v, reachFrom(v, n.id, tags)));
      out.push({ iface: i, node: n, callers, reaches, requirements: reqs.filter((q) => q.covers.includes(i.ref) || (q.node === n.id && q.covers.length === 0)) });
    }
  }
  return out;
}

/** The tags of the data a node can get at through its own links, a few links deep. Stops at outside systems and clients. */
function reachFrom(v: SecurityView, start: string, tags: (s: string[]) => Tagged, depth = 4): Tagged {
  const nodes = new Map(v.nodes.map((n) => [n.id, n]));
  const ifaces = new Map(v.nodes.flatMap((n) => n.interfaces).map((i) => [i.ref, i]));
  const out: Tagged = new Map();
  const seen = new Set([start]);
  let ring = [start];
  for (let d = 0; d < depth && ring.length; d++) {
    const next: string[] = [];
    for (const id of ring) {
      for (const e of v.edges) {
        if (e.owner !== id) continue;
        merge(out, tags([...e.shapes, ...e.returns]));
        const held = e.iface ? ifaces.get(e.iface) : undefined;
        if (held?.holds) merge(out, tags(held.takes));
        const other = e.owner === e.from ? e.to : e.from;
        const o = nodes.get(other);
        if (!o || seen.has(other) || o.kind === 'external' || o.kind === 'actor' || isClient(o)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    ring = next;
  }
  return out;
}

export interface DataExit {
  edge: Edge;
  /** The node the data arrives at. */
  to: string;
  /** Tag -> fields, for the tags a policy covers. */
  tags: Tagged;
  /** Tags whose policy does not list this destination. */
  denied: string[];
}

/** Every link that carries policed data out of the system: to an outside system, or, for secrets, to a client. */
export function dataExits(v: SecurityView): DataExit[] {
  const nodes = new Map(v.nodes.map((n) => [n.id, n]));
  const policy = policyOf(v);
  const tags = tagIndex(v);
  const out: DataExit[] = [];
  const consider = (edge: Edge, to: string, shapes: string[]): void => {
    const n = nodes.get(to);
    if (!n || !shapes.length) return;
    const outside = OUTSIDE.has(n.kind);
    const t = new Map([...tags(shapes)].filter(([k]) => policy[k] && (outside || (k === 'secret' && isClient(n)))));
    if (!t.size) return;
    const denied = [...t.keys()].filter((k) => !policy[k].leaves.some((l) => inside(to, l)));
    out.push({ edge, to, tags: t, denied });
  };
  for (const e of v.edges) {
    consider(e, e.to, e.shapes);
    consider(e, e.from, e.returns);
  }
  return out;
}

/** A problem with the changes its elements belong to, so approval can be refused for the change at fault. */
export interface Finding extends Problem {
  changes: string[];
}

const tagsOfNode = (n: GNode | undefined): string[] => (n ? [n.change, n.modify].filter((x): x is string => !!x) : []);
const tagsOf = (x: { change?: string; modify?: string }): string[] => [x.change, x.modify].filter((c): c is string => !!c);

/** The security findings: errors and warnings the compiler adds to the problem list. */
export function securityFindings(v: SecurityView): Finding[] {
  const out: Finding[] = [];
  const nodes = new Map(v.nodes.map((n) => [n.id, n]));
  const ancestors = (id: string): GNode[] => {
    const list: GNode[] = [];
    for (let p = nodes.get(id)?.parent; p; p = nodes.get(p)?.parent) list.push(nodes.get(p)!);
    return list;
  };
  const changesOfNode = (id: string): string[] => [...new Set([nodes.get(id), ...ancestors(id)].flatMap(tagsOfNode))];
  const add = (level: Problem['level'], code: string, message: string, ref: string | undefined, file: string | undefined, changes: string[]): void => {
    out.push({ level, code, message, ref, file, changes: [...new Set(changes)], ...(level === 'warning' ? { group: 'incomplete' as const } : {}) });
  };

  // Entry points: who may call, and what is behind them.
  const entries = entryPoints(v);
  for (const ep of entries) {
    const { iface: i, node: n } = ep;
    const ch = [...tagsOf(i), ...changesOfNode(n.id), ...v.edges.filter((e) => e.iface === i.ref && ep.callers.includes(e.owner)).flatMap(tagsOf)];
    const from = ep.callers.join(', ');
    if (!i.auth) {
      add('warning', 'no-auth', `"${i.ref}" is reached from ${from} and does not say who may call it. Add "auth:": none, user, service, admin, or the name of the scheme.`, i.ref, n.source, ch);
    } else if (i.auth === 'none' && ep.reaches.size) {
      add('error', 'open-entry', `"${i.ref}" takes calls from ${from} with no authentication ("auth: none"), and it reaches sensitive data: ${tagList(ep.reaches)}. Require authentication, or keep the data out of its reach.`, i.ref, n.source, ch);
    } else if (i.auth !== 'none' && ep.reaches.size && ep.requirements.length === 0) {
      add('warning', 'no-security-requirement', `"${i.ref}" is an entry point (from ${from}) that reaches ${tagList(ep.reaches)}, and no requirement of kind security covers it. Add one that says who may get which data, with a test: { id, kind: security, text, covers: [${i.ref}] }.`, i.ref, n.source, ch);
    }
  }

  // Data that leaves the system to a place its policy does not list.
  for (const x of dataExits(v)) {
    if (!x.denied.length) continue;
    const e = x.edge;
    const fields = x.denied.map((t) => `@${t} (${x.tags.get(t)!.slice(0, 3).join(', ')})`).join(', ');
    const owner = nodes.get(e.owner);
    add('error', 'data-leak', `${e.owner} ${e.verb} ${e.iface ?? e.to}${e.from === x.to ? ' (the answer)' : ''} carries ${fields} to "${x.to}", which "data:" in system.yaml does not list for ${x.denied.length === 1 ? 'that tag' : 'those tags'}. Keep the fields out of the link, or add "${x.to}" to the tag's "leaves:" if it may have them.`, e.ref ?? e.owner, owner?.source, [...tagsOf(e), ...changesOfNode(e.owner)]);
  }

  // `only:` names who may link to an interface: callers and senders, or writers for a table.
  for (const n of v.nodes) {
    for (const i of n.interfaces) {
      if (!i.only?.length) continue;
      for (const e of v.edges) {
        if (e.iface !== i.ref || e.owner === n.id) continue;
        const counts = i.holds ? e.verb === 'writes' : e.verb === 'calls' || e.verb === 'sends';
        if (!counts || i.only.some((o) => inside(e.owner, o))) continue;
        add('error', 'not-allowed', `${e.owner} ${e.verb} "${i.ref}", which only ${i.only.join(', ')} may ${i.holds ? 'write' : 'use'}. Go through one of them, or change "only:" if this one should be allowed.`, e.ref ?? e.owner, nodes.get(e.owner)?.source, [...tagsOf(e), ...changesOfNode(e.owner)]);
      }
    }
  }

  // Secrets: where they are held, and code that reads one without saying so.
  for (const n of v.nodes) {
    const declared = new Set([n, ...ancestors(n.id)].flatMap((x) => x.secrets));
    if (n.client) {
      const own = n.secrets;
      const read = [...new Set(n.env.filter((r) => SECRET_NAME.test(r.name) && !PUBLIC_ENV.test(r.name)).map((r) => r.name))];
      if (own.length) add('error', 'client-secret', `"${n.id}" runs on the user's device and holds secrets: ${own.join(', ')}. Anything shipped to a client can be read by its user. Move them to a server node.`, n.id, n.source, changesOfNode(n.id));
      if (read.length) add('error', 'client-secret', `"${n.id}" runs on the user's device and its code reads ${read.join(', ')} (${n.env.find((r) => r.name === read[0])!.file}). Move the call that needs ${read.length === 1 ? 'it' : 'them'} to a server node.`, n.id, n.source, changesOfNode(n.id));
      continue;
    }
    const exposed = n.secrets.filter((s) => PUBLIC_ENV.test(s));
    if (exposed.length) add('error', 'client-secret', `"${n.id}" holds ${exposed.join(', ')}, whose prefix makes the build copy ${exposed.length === 1 ? 'it' : 'them'} into code shipped to the browser. Rename ${exposed.length === 1 ? 'it' : 'them'} without the prefix.`, n.id, n.source, changesOfNode(n.id));
    const undeclared = [...new Set(n.env.filter((r) => SECRET_NAME.test(r.name) && !declared.has(r.name)).map((r) => r.name))];
    if (undeclared.length) {
      const where = n.env.find((r) => r.name === undeclared[0])!;
      add('warning', 'undeclared-secret', `"${n.id}" reads ${undeclared.slice(0, 6).join(', ')}${undeclared.length > 6 ? ', …' : ''} from the environment (${where.file}:${where.line}), which ${undeclared.length === 1 ? 'looks like a credential' : 'look like credentials'} the model does not list. Add ${undeclared.length === 1 ? 'it' : 'them'} to the node's "secrets:".`, n.id, n.source, changesOfNode(n.id));
    }
  }

  // A change is not done while an entry point it adds or alters reaches sensitive data with nothing proving who may get it.
  for (const c of v.changes) {
    if (c.state !== 'done') continue;
    for (const ep of entries) {
      const mine = tagsOf(ep.iface).includes(c.id) || c.nodes.includes(ep.node.id);
      if (!mine || !ep.reaches.size || ep.iface.auth === 'none') continue;
      if (!ep.requirements.length) add('error', 'not-done', `Change "${c.id}" is marked done, but its entry point "${ep.iface.ref}" reaches ${tagList(ep.reaches)} and no requirement of kind security covers it.`, c.id, undefined, [c.id]);
      else if (ep.requirements.every((q) => q.state === 'failing')) add('error', 'not-done', `Change "${c.id}" is marked done, but the security requirements of "${ep.iface.ref}" fail: ${ep.requirements.map((q) => q.ref).join(', ')}.`, c.id, undefined, [c.id]);
    }
  }
  return out;
}

/** What a change does to the security of the system, for the person who approves it. */
export function changeSecurity(v: SecurityView, id: string): { lines: string[]; errors: Finding[] } {
  const c = v.changes.find((x) => x.id === id);
  const lines: string[] = [];
  if (!c) return { lines, errors: [] };
  const inChange = (x: { change?: string; modify?: string }): boolean => x.change === id || x.modify === id;
  const nodeIn = (nid: string): boolean => c.nodes.includes(nid) || v.nodes.some((n) => inChange(n) && inside(nid, n.id));
  const entries = entryPoints(v).filter((ep) => inChange(ep.iface) || nodeIn(ep.node.id) || v.edges.some((e) => e.iface === ep.iface.ref && inChange(e) && ep.callers.includes(e.owner)));
  if (entries.length) {
    lines.push('Entry points it adds or alters:');
    for (const ep of entries) lines.push(`  ${ep.iface.ref} (auth: ${ep.iface.auth ?? 'not stated'}${ep.iface.only?.length ? `; only ${ep.iface.only.join(', ')}` : ''}) from ${ep.callers.join(', ')}${ep.reaches.size ? `; reaches ${tagList(ep.reaches)}` : ''}${ep.requirements.length ? `; proven by ${ep.requirements.map((q) => q.ref).join(', ')}` : ''}`);
  }
  const exits = dataExits(v).filter((x) => inChange(x.edge) || nodeIn(x.edge.owner));
  if (exits.length) {
    lines.push('Sensitive data it sends out of the system:');
    for (const x of exits) lines.push(`  ${tagList(x.tags)} -> ${x.to}${x.denied.length ? ` (NOT allowed for @${x.denied.join(', @')})` : ' (allowed by data: in system.yaml)'}`);
  }
  const holders = v.nodes.filter((n) => nodeIn(n.id) && n.secrets.length);
  if (holders.length) lines.push('Secrets it holds:', ...holders.map((n) => `  ${n.id}: ${n.secrets.join(', ')}`));
  const errors = securityFindings(v).filter((f) => f.level === 'error' && f.code !== 'not-done' && f.changes.includes(id));
  return { lines, errors };
}

/** The constraints on a set of nodes, for whoever plans work on them: boundaries, who may call, data policy, secrets, security requirements, rules. */
export function mustHold(v: SecurityView & { system: { data: DataPolicy } }, ids: string[]): string[] {
  const nodes = new Map(v.nodes.map((n) => [n.id, n]));
  const tags = tagIndex(v);
  const policy = policyOf(v);
  const out: string[] = [];
  const seenRules = new Set<string>();
  const policed = new Set<string>();
  for (const id of [...new Set(ids)]) {
    const n = nodes.get(id);
    if (!n) continue;
    const lines: string[] = [];
    if (n.protect) lines.push('protected: editing its files needs an approved change that modifies it');
    for (const b of n.never) lines.push(`never touches ${b.node}${b.why ? ` (${b.why})` : ''}`);
    for (const i of n.interfaces) {
      const bits = [i.auth ? `auth ${i.auth}` : '', i.only?.length ? `only ${i.only.join(', ')} may ${i.holds ? 'write' : 'use'} it` : ''].filter(Boolean);
      if (bits.length) lines.push(`${i.ref}: ${bits.join('; ')}`);
      for (const t of tags([...i.takes, ...i.gives]).keys()) if (policy[t]) policed.add(t);
    }
    if (n.secrets.length) lines.push(`holds secrets ${n.secrets.join(', ')}: never log them, return them or send them to a client`);
    if (n.client) lines.push('runs on the user\'s device: holds no secret, and its users can read and change anything it does');
    for (const q of n.requirements) if (q.kind === 'security') lines.push(`must hold (security): ${q.text}`);
    for (const r of n.rules) {
      const key = `${r.from}|${r.text}`;
      if (seenRules.has(key)) continue;
      seenRules.add(key);
      lines.push(`rule${r.from !== n.id ? ` (from ${r.from})` : ''}: ${r.text}`);
    }
    if (lines.length) out.push(`- ${n.id}`, ...lines.map((l) => `  ${l}`));
  }
  for (const t of policed) out.push(`- @${t} data may leave the system only to: ${policy[t].leaves.join(', ') || 'nowhere'}`);
  return out;
}

/** Entry points, data leaving, secrets and protected nodes, for the whole system or one change. */
export function surfaceText(v: SecurityView, change?: string): string {
  const out: string[] = [];
  if (change) {
    const c = v.changes.find((x) => x.id === change);
    if (!c) return `No change "${change}".`;
    const { lines, errors } = changeSecurity(v, change);
    out.push(`Security surface of change ${change} (${c.state}):`);
    out.push(...(lines.length ? lines : ['  It adds no entry point, sends no sensitive data out of the system and holds no secret.']));
    if (errors.length) out.push('Errors:', ...errors.map((e) => `  ${e.code}: ${e.message}`));
    return out.join('\n');
  }
  const entries = entryPoints(v);
  out.push(`Entry points (${entries.length}): interfaces an actor, an outside system or a client reaches`);
  for (const ep of entries) {
    out.push(`  ${ep.iface.ref}${ep.iface.via ? ` via ${ep.iface.via}` : ''}${ep.iface.route ? ` ${ep.iface.route}` : ''}: auth ${ep.iface.auth ?? 'NOT STATED'}${ep.iface.only?.length ? `; only ${ep.iface.only.join(', ')}` : ''}`);
    out.push(`    from ${ep.callers.join(', ')}${ep.reaches.size ? `; reaches ${tagList(ep.reaches)}` : '; reaches no tagged data'}`);
    if (ep.reaches.size) out.push(`    ${ep.requirements.length ? `proven by ${ep.requirements.map((q) => `${q.ref} [${q.state}]`).join(', ')}` : 'no security requirement covers it'}`);
  }
  const exits = dataExits(v);
  out.push('', `Sensitive data leaving the system (${exits.length} link${exits.length === 1 ? '' : 's'})`);
  for (const x of exits) out.push(`  ${x.edge.owner} ${x.edge.verb} ${x.edge.iface ?? x.edge.to}: ${tagList(x.tags)} -> ${x.to}${x.denied.length ? `  NOT ALLOWED (@${x.denied.join(', @')})` : ''}`);
  const policy = policyOf(v);
  out.push('', 'Data policy (data: in system.yaml)', ...Object.entries(policy).map(([t, p]) => `  @${t} may leave to: ${p.leaves.join(', ') || 'nowhere'}`));
  const holders = v.nodes.filter((n) => n.secrets.length || n.env.some((r) => SECRET_NAME.test(r.name)));
  out.push('', 'Secrets');
  if (!holders.length) out.push('  none declared or seen in the code');
  for (const n of holders) {
    const seen = [...new Set(n.env.filter((r) => SECRET_NAME.test(r.name)).map((r) => r.name))];
    out.push(`  ${n.id}${n.client ? ' (client)' : ''}: ${n.secrets.join(', ') || 'none declared'}${seen.length ? `; read in code: ${seen.join(', ')}` : ''}`);
  }
  const prot = v.nodes.filter((n) => n.protect && !(n.parent && v.nodes.find((p) => p.id === n.parent)?.protect));
  out.push('', `Protected nodes: ${prot.map((n) => n.id).join(', ') || 'none'}`);
  const clients = v.nodes.filter((n) => n.client && !(n.parent && v.nodes.find((p) => p.id === n.parent)?.client));
  out.push(`Client nodes: ${clients.map((n) => n.id).join(', ') || 'none (mark code that runs on the user\'s device with "client: true")'}`);
  return out.join('\n');
}

/** What the model guards, and what it lets through, as comparable lines. Removing a guard or adding an allowance weakens it. */
export function guardsOf(g: SecurityView & { system: { data: DataPolicy; ignore?: Array<{ path: string }>; accepts?: Array<{ code: string; ref?: string; file?: string; match?: string }>; gate?: boolean } }): { guards: Set<string>; allowances: Set<string> } {
  const guards = new Set<string>();
  const allowances = new Set<string>();
  for (const n of g.nodes) {
    if (n.protect && !(n.parent && g.nodes.find((p) => p.id === n.parent)?.protect)) guards.add(`protect ${n.id}`);
    for (const b of n.never) if (b.from === n.id) guards.add(`never ${n.id} -> ${b.node}`);
    for (const i of n.interfaces) {
      if (i.auth && i.auth !== 'none') guards.add(`auth ${i.ref}`);
      for (const o of i.only ?? []) guards.add(`only ${i.ref}: ${o}`);
      if (i.auth === 'none') allowances.add(`auth none ${i.ref}`);
    }
    for (const q of n.requirements) guards.add(`requirement ${q.ref}${q.kind === 'security' ? ' (security)' : ''}`);
  }
  for (const [t, p] of Object.entries(g.system.data)) {
    guards.add(`data policy @${t}`);
    for (const l of p.leaves) allowances.add(`@${t} may leave to ${l}`);
  }
  for (const x of g.system.ignore ?? []) allowances.add(`ignore ${x.path}`);
  for (const a of g.system.accepts ?? []) allowances.add(`accept ${[a.code, a.ref, a.file, a.match ? `"${a.match}"` : ''].filter(Boolean).join(' ')}`);
  if (g.system.gate === false) allowances.add('gate: off');
  return { guards, allowances };
}
