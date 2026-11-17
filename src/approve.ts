// Approving a change: the one step that belongs to a person. It sets the change to approved and
// records who approved which elements, so anything that joins the change later is visible
// ("scope-changed") and is not built on the strength of the earlier approval.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { compile } from './compile.js';
import { APPROVALS_FILE, modelDir, readApprovals, type Approval } from './paths.js';
import { git } from './repo.js';

function writeApprovals(root: string, all: Record<string, Approval>): void {
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(root, modelDir(root), APPROVALS_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}

function changeFile(root: string, id: string): string | null {
  for (const ext of ['yaml', 'yml']) {
    const p = path.join(root, modelDir(root), 'changes', `${id}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Writes the record for a change that is already approved. Returns the elements recorded, or null when there is nothing to record. */
export function recordApproval(root: string, id: string, by?: string): string[] | null {
  const g = compile(root);
  const c = g.changes.find((x) => x.id === id);
  if (!c || c.state !== 'approved' || c.elements.length === 0) return null;
  const all = readApprovals(root);
  const who = by ?? git(root, ['config', 'user.name'])?.trim() ?? '';
  const same = all[id] && JSON.stringify(all[id].elements) === JSON.stringify(c.elements);
  if (!same) {
    all[id] = { by: who, at: new Date().toISOString(), elements: c.elements };
    // Records of changes that no longer exist are dropped with it.
    const known = new Set(g.changes.map((x) => x.id));
    for (const key of Object.keys(all)) if (!known.has(key)) delete all[key];
    writeApprovals(root, all);
  }
  return c.elements;
}

/** What "armature approve <change>" does: sets the state, records the approval, and says what was approved. */
export function approveChange(root: string, id: string, by?: string): string {
  const file = changeFile(root, id);
  if (!file) return `No change "${id}". "armature status" lists the changes.`;
  const g = compile(root);
  const c = g.changes.find((x) => x.id === id)!;
  if (c.state === 'done' || c.state === 'dropped') return `Change "${id}" is ${c.state}. Only a proposed or approved change can be approved.`;
  if (c.elements.length === 0) return `Change "${id}" has no elements yet, so there is nothing to approve. Tag the planned elements with "change: ${id}" first.`;
  const errors = g.problems.filter((p) => p.level === 'error');
  if (errors.length) return `The model has ${errors.length} error${errors.length === 1 ? '' : 's'}; fix them before approving ("armature check --only errors").`;
  if (c.state !== 'approved') {
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    doc.set('state', 'approved');
    fs.writeFileSync(file, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  }
  const elements = recordApproval(root, id, by) ?? [];
  const rec = readApprovals(root)[id];
  const out = [`Approved change ${id}: ${c.title}`, `  by ${rec?.by || 'unknown'} at ${rec?.at ?? ''}`, `  ${elements.length} element${elements.length === 1 ? '' : 's'}:`];
  for (const e of elements) out.push(`    ${e}`);
  if (c.waits.length) out.push(`  It comes after ${c.waits.join(', ')}, which ${c.waits.length === 1 ? 'is' : 'are'} not done yet.`);
  out.push(`Recorded in ${modelDir(root)}/${APPROVALS_FILE}. Commit it with the change.`);
  return out.join('\n');
}

const PENDING = 'pending-approval.json';
const PENDING_FOR = 60 * 60 * 1000;

/** Notes that the person was just asked to approve a change, so the record can be written once the edit goes through. */
export function notePendingApproval(root: string, id: string): void {
  const dir = path.join(root, modelDir(root), '.cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PENDING), JSON.stringify({ id, at: Date.now() }));
}

/**
 * After an approval the person confirmed: records it, with what the change holds now. Called after
 * each edit to the model and once more when the agent stops, so elements written straight after the
 * approval are part of it. `final` ends the window.
 */
export function settleApproval(root: string, final: boolean): void {
  const file = path.join(root, modelDir(root), '.cache', PENDING);
  let pending: { id?: string; at?: number };
  try {
    pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const live = typeof pending.id === 'string' && typeof pending.at === 'number' && Date.now() - pending.at < PENDING_FOR;
  if (live) recordApproval(root, pending.id as string);
  if (final || !live) fs.rmSync(file, { force: true });
}
