// Data shapes read from code: Drizzle tables, Zod objects, Pydantic models, and SQL tables with
// every later ALTER TABLE replayed onto the CREATE.
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import type { CodeIndex, SchemaField } from './code.js';

export interface CodeShape {
  kind: 'drizzle' | 'zod' | 'pydantic' | 'sql' | 'ts' | 'java';
  fields: SchemaField[];
  table?: string;
}

/** Fields for a `file#symbol` pointer, or null when the code index has no schema there. */
export function schemaFor(idx: CodeIndex, source: string): CodeShape | null {
  const [file, symbol] = source.split('#');
  const f = idx.files[file];
  if (!f || !symbol) return null;
  const s = f.schemas?.[symbol];
  if (s && s.fields.length) return { kind: s.kind, fields: s.fields, table: s.table };
  if (f.lang === 'sql') return sqlTable(idx, file, symbol.toLowerCase());
  // A Drizzle pointer may name the table rather than the constant.
  for (const [, sch] of Object.entries(f.schemas ?? {})) if (sch.table === symbol && sch.fields.length) return { kind: sch.kind, fields: sch.fields, table: sch.table };
  return null;
}

/** Replays CREATE TABLE in `file` and every later ADD, DROP and RENAME COLUMN for the table. */
export function sqlTable(idx: CodeIndex, file: string, table: string): CodeShape | null {
  const files = Object.values(idx.files).filter((f) => f.lang === 'sql' && f.sql?.length).sort((a, b) => a.path.localeCompare(b.path));
  let cols: SchemaField[] | null = null;
  for (const f of files) {
    if (cols === null && f.path < file) continue;
    for (const op of f.sql ?? []) {
      if (op.table !== table) continue;
      if (op.op === 'create') {
        if (cols === null ? f.path === file : true) cols = [...(op.fields ?? [])];
      } else if (cols && op.op === 'add') {
        const current: SchemaField[] = cols;
        for (const c of op.fields ?? []) if (!current.some((x) => x.name === c.name)) current.push(c);
      } else if (cols && op.op === 'drop') {
        cols = cols.filter((c) => c.name !== op.col);
      } else if (cols && op.op === 'rename') {
        cols = cols.map((c) => (c.name === op.col ? { ...c, name: op.to ?? c.name } : c));
      }
    }
  }
  return cols ? { kind: 'sql', fields: cols, table } : null;
}

/** Names compared loosely: companyNumber and company_number are the same field. */
export function sameName(a: string, b: string): boolean {
  return a.replace(/_/g, '').toLowerCase() === b.replace(/_/g, '').toLowerCase();
}

/** The state a change file gives, or undefined when there is no such change. */
function changeState(archDir: string, id: string): string | undefined {
  for (const ext of ['yaml', 'yml']) {
    try {
      const text = nodeFs.readFileSync(nodePath.join(archDir, 'changes', `${id}.${ext}`), 'utf8');
      return text.match(/^state:\s*["']?([a-z]+)/m)?.[1] ?? 'proposed';
    } catch {
      /* try the other extension */
    }
  }
  return undefined;
}

/**
 * Rewrites the `fields:` of every shape that has a `source:` the code index can read, so the model
 * file matches the code. Keeps the model's tags (such as @pii). Returns the shapes changed.
 */
export async function syncShapeFiles(archDir: string, idx: CodeIndex, only: string[] = []): Promise<string[]> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const YAML = (await import('yaml')).default;
  const changed: string[] = [];
  const dir = path.join(archDir, 'shapes');
  for (const name of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const file = path.join(dir, name);
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    let touched = false;
    for (const item of (doc.contents as any)?.items ?? []) {
      const id = String(item.key?.value ?? item.key);
      if (only.length && !only.includes(id)) continue;
      const source = item.value?.get?.('source');
      if (!source) continue;
      const code = schemaFor(idx, String(source));
      if (!code) continue;
      const old = (item.value.get('fields')?.toJSON?.() ?? {}) as Record<string, string>;
      const fields: Record<string, string> = {};
      for (const f of code.fields) {
        const prev = Object.entries(old).find(([k]) => sameName(k, f.name));
        const tags = prev ? String(prev[1]).split(/\s+/).filter((p) => p.startsWith('@')) : [];
        fields[f.name] = [f.type, ...tags].join(' ');
      }
      // A shape that an unfinished change is altering keeps the fields the code does not have yet: they are planned.
      const modify = item.value.get('modify');
      if (modify && changeState(archDir, String(modify)) !== 'done') {
        for (const [k, v] of Object.entries(old)) if (!code.fields.some((f) => sameName(f.name, k))) fields[k] = String(v);
      }
      if (JSON.stringify(fields) === JSON.stringify(old)) continue;
      item.value.set('fields', doc.createNode(fields));
      changed.push(id);
      touched = true;
    }
    if (touched) fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  }
  return changed;
}
