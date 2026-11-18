// Where the model lives in a repo. Kept apart from the compiler so hooks that run before a tool
// call can find the folder without loading everything else.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** The folder that holds the model. */
export const MODEL_DIR = 'armature';

/** True when a repo has a model. */
export function hasModel(dir: string): boolean {
  return fs.existsSync(path.join(dir, MODEL_DIR, 'system.yaml'));
}

/** A `docs:` value from system.yaml as a clean folder relative to the repo, or null when it cannot be one. */
export function cleanDocsSetting(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s) || s.split('/').includes('..')) return null;
  return s;
}

/** The folder that holds the documents: `docs:` in system.yaml, or the docs folder inside the model. */
export function docsDir(root: string): string {
  const dir = MODEL_DIR;
  let value: unknown;
  try {
    value = YAML.parse(fs.readFileSync(path.join(root, dir, 'system.yaml'), 'utf8'))?.docs;
  } catch {
    value = undefined;
  }
  return cleanDocsSetting(value) ?? `${dir}/docs`;
}

/** Where a new plan goes: one folder per kind inside the model, or beside the plans in a repo's own folder. */
export function newPlanPath(docs: string, dir: string): string {
  return docs === `${dir}/docs` ? `${docs}/plans/<id>.md` : `${docs}/<id>-plan.md`;
}

/** Who approved which elements of each change. Written by "armature approve"; never edited by hand. */
export const APPROVALS_FILE = 'approvals.lock.json';

export interface Approval {
  by: string;
  at: string;
  /** Everything the change added, altered or retired when it was approved, one line each. */
  elements: string[];
}

/** The approvals recorded for a repo, by change id. */
export function readApprovals(root: string): Record<string, Approval> {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, MODEL_DIR, APPROVALS_FILE), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}
