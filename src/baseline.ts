// A baseline of the warnings a repo has today, so a check can fail on new ones without first
// clearing the old ones. Warnings never block by themselves; with a baseline, "armature check
// --new --fail-on wrong" stops the model from getting worse.
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_DIR } from './paths.js';
import type { Problem } from './types.js';

export const BASELINE_FILE = 'baseline.json';

/** What makes two warnings the same one: the code and what it is about. The message is left out, because it carries counts. */
const keyOf = (p: Problem): string => `${p.code}|${p.ref ?? ''}|${p.file ?? ''}`;

export function readBaseline(root: string): Record<string, number> | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, MODEL_DIR, BASELINE_FILE), 'utf8'));
    return data && typeof data.warnings === 'object' ? data.warnings : null;
  } catch {
    return null;
  }
}

/** Records today's warnings. Returns how many. */
export function writeBaseline(root: string, problems: Problem[]): number {
  const warnings: Record<string, number> = {};
  for (const p of problems) if (p.level === 'warning') warnings[keyOf(p)] = (warnings[keyOf(p)] ?? 0) + 1;
  const sorted = Object.fromEntries(Object.entries(warnings).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(root, MODEL_DIR, BASELINE_FILE), `${JSON.stringify({ written: new Date().toISOString().slice(0, 10), warnings: sorted }, null, 2)}\n`);
  return Object.values(warnings).reduce((a, b) => a + b, 0);
}

/** Errors, and the warnings the baseline does not already hold. */
export function newSince(problems: Problem[], baseline: Record<string, number>): Problem[] {
  const left = { ...baseline };
  return problems.filter((p) => {
    if (p.level !== 'warning') return true;
    const k = keyOf(p);
    if ((left[k] ?? 0) > 0) {
      left[k]--;
      return false;
    }
    return true;
  });
}
