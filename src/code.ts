// The code index: for every source file, its top-level symbols and what it imports.
// Built with tree-sitter, cached under armature/.cache, and linked to the model by file ownership.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MODEL_DIR } from './paths.js';
import { readRepo } from './repo.js';

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'reexport' | 'table';
  line: number;
  sig: string;
  doc?: string;
  exported: boolean;
}

export interface CodeImport {
  spec: string;
  names: string[];
  line: number;
  /** Repo-relative file the import resolves to, or null for an outside package. */
  file: string | null;
  /** Package name when it is not a file in this repo. */
  pkg?: string;
  /** Local name -> imported name ("*" for a namespace import). */
  as?: Record<string, string>;
  /** Java: a class of the same package used without an import line. Dropped when no file matches. */
  implicit?: boolean;
}

/** A use of an imported or top-level name: n is the local name, or ns.member for a namespace import. */
export interface CodeRef {
  n: string;
  l: number;
  /** The top-level symbol the use sits in. */
  in?: string;
  /** 1 when it is called or rendered, 0 for any other use (types, values passed along). */
  c: 0 | 1;
  /** How many times, within the same enclosing symbol. */
  x: number;
}

export interface SchemaField {
  name: string;
  type: string;
}

/** A data structure defined in code: a Drizzle table, a Zod object, a Pydantic model, a SQL table, a Java record or Lombok class. */
export interface CodeSchema {
  kind: 'drizzle' | 'zod' | 'pydantic' | 'sql' | 'ts' | 'java';
  table?: string;
  fields: SchemaField[];
}

/** A SQL migration step, kept in order so later ALTERs can be replayed onto the CREATE. */
export interface SqlOp {
  op: 'create' | 'add' | 'drop' | 'rename';
  table: string;
  fields?: SchemaField[];
  col?: string;
  to?: string;
}

/** Things the code does at run time that imports cannot show. */
export interface RuntimeHint {
  /**
   * entry: a file this one loads by path at run time (Temporal workflowsPath, import.meta.glob); main: a Python script,
   * or a class a framework starts by itself (an aspect); env: an environment variable read;
   * bean: a class a framework wires by type (a Spring component), v being the interface or class it implements or extends.
   */
  k: 'route' | 'http' | 'queue' | 'workflow' | 'table' | 'entry' | 'main' | 'env' | 'bean';
  v: string;
  op?: string;
  l: number;
}

export interface CodeFile {
  path: string;
  lang: string;
  lines: number;
  mtime: number;
  size: number;
  symbols: CodeSymbol[];
  imports: CodeImport[];
  refs: CodeRef[];
  schemas: Record<string, CodeSchema>;
  /** Named string-literal unions and enums, as enum(a|b): resolves field types that name them. */
  enums?: Record<string, string>;
  sql?: SqlOp[];
  hints: RuntimeHint[];
  /** Search terms with their weight (path and names count more than body text). */
  terms: Record<string, number>;
  test: boolean;
  /** Hash of the content, for caches keyed on it. */
  hash: string;
}

/** Bump when extraction changes, so unchanged files are parsed again with the new rules. */
export const EXTRACTOR = 12;

export interface CodeIndex {
  version: 3;
  extractor?: number;
  builtAt: string;
  files: Record<string, CodeFile>;
}

const LANG_OF: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.jsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.sql': 'sql', '.java': 'java',
};
export const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?|e2e)\/|(^|\/)test_[^/]+\.py$|_test\.py$/;
/** Java keeps every source of a test project under src/test/java, so only the class name says what is a test. */
const JAVA_TEST_FILE = /(Test|Tests|IT|Check)\.java$/;
/** Whether a path is a test file, by the conventions of its language. */
export function isTestFile(file: string): boolean {
  return file.endsWith('.java') ? JAVA_TEST_FILE.test(file) : TEST_FILE.test(file);
}
const TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.turbo|coverage|vendor|__pycache__|\.venv)\//;
const MAX_BYTES = 400 * 1024;

export function indexPath(root: string): string {
  return path.join(root, MODEL_DIR, '.cache', 'code-index.json');
}

export function readCodeIndex(root: string): CodeIndex | null {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(root), 'utf8'));
    return idx.version === 3 ? idx : null;
  } catch {
    return null;
  }
}

function oneLine(text: string, max: number): string {
  const first = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** The declaration without its body: enough to know how to call or use it. */
function signature(text: string): string {
  let head = text;
  const brace = head.search(/\{\s*(\n|$)/);
  if (brace > 0) head = head.slice(0, brace);
  head = head.replace(/\s+/g, ' ').trim().replace(/[=,{(]$/, '').trim();
  return head.length > 150 ? `${head.slice(0, 149)}…` : head;
}

function docOf(node: any): string | undefined {
  const prev = node.previousSibling;
  if (!prev || prev.type !== 'comment' || node.startPosition.row - prev.endPosition.row > 1) return undefined;
  const lines = String(prev.text)
    .split('\n')
    .map((l: string) => l.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/+|#)\s?/, '').replace(/\*\/\s*$/, '').trim())
    .filter((l: string) => l && !l.startsWith('@') && !/^eslint|^ts-|^prettier/.test(l));
  return lines.length ? oneLine(lines.join(' '), 140) : undefined;
}

type Raw = Pick<CodeFile, 'symbols' | 'refs' | 'schemas' | 'hints'> & { enums?: Record<string, string>; sql?: SqlOp[]; imports: Array<Omit<CodeImport, 'file' | 'pkg'>> };

function extractTs(root: any, source: string): Raw {
  const symbols: CodeSymbol[] = [];
  const imports: Raw['imports'] = [];
  const strip = (s: string): string => s.replace(/^['"`]|['"`]$/g, '');
  const declared = (decl: any, exported: boolean, docNode: any, isDefault: boolean): void => {
    const line = decl.startPosition.row + 1;
    const doc = docOf(docNode);
    const named = (kind: CodeSymbol['kind']): void => {
      const name = decl.childForFieldName('name')?.text ?? (isDefault ? 'default' : null);
      if (name) symbols.push({ name, kind, line, sig: signature(decl.text), doc, exported });
    };
    switch (decl.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature':
        return named('function');
      case 'class_declaration':
      case 'abstract_class_declaration':
        return named('class');
      case 'interface_declaration':
        return named('interface');
      case 'type_alias_declaration':
        return named('type');
      case 'enum_declaration':
        return named('enum');
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const d of decl.namedChildren) {
          if (d.type !== 'variable_declarator') continue;
          const nameNode = d.childForFieldName('name');
          if (!nameNode || nameNode.type !== 'identifier') continue;
          const value = d.childForFieldName('value');
          const fn = value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function');
          const keyword = decl.text.match(/^(const|let|var)/)?.[1] ?? 'const';
          symbols.push({ name: nameNode.text, kind: fn ? 'function' : 'const', line: d.startPosition.row + 1, sig: signature(`${keyword} ${d.text}`), doc, exported });
        }
        return;
      default:
        if (isDefault) symbols.push({ name: 'default', kind: 'const', line, sig: oneLine(`export default ${decl.text}`, 120), doc, exported });
    }
  };
  for (const node of root.children) {
    if (node.type === 'import_statement') {
      const src = node.childForFieldName('source');
      if (!src) continue;
      const names: string[] = [];
      const as: Record<string, string> = {};
      for (const spec of node.descendantsOfType('import_specifier')) {
        const name = spec.childForFieldName('name')?.text ?? spec.text;
        names.push(name);
        as[spec.childForFieldName('alias')?.text ?? name] = name;
      }
      const clause = node.namedChildren.find((c: any) => c.type === 'import_clause');
      for (const c of clause?.namedChildren ?? []) {
        if (c.type === 'identifier') {
          names.push('default');
          as[c.text] = 'default';
        }
        if (c.type === 'namespace_import') {
          names.push('*');
          const local = c.namedChildren.find((k: any) => k.type === 'identifier')?.text;
          if (local) as[local] = '*';
        }
      }
      imports.push({ spec: strip(src.text), names, line: node.startPosition.row + 1, as });
    } else if (node.type === 'export_statement') {
      const src = node.childForFieldName('source');
      const decl = node.childForFieldName('declaration');
      const isDefault = node.children.some((c: any) => c.type === 'default');
      if (src) {
        const names = node.descendantsOfType('export_specifier').map((s: any) => (s.childForFieldName('alias') ?? s.childForFieldName('name'))?.text ?? s.text);
        imports.push({ spec: strip(src.text), names: names.length ? names : ['*'], line: node.startPosition.row + 1 });
        for (const n of names) symbols.push({ name: n, kind: 'reexport', line: node.startPosition.row + 1, sig: oneLine(node.text, 120), exported: true });
      } else if (decl) {
        declared(decl, true, node, isDefault);
      } else if (isDefault) {
        const value = node.namedChildren[node.namedChildren.length - 1];
        if (value) declared(value, true, node, true);
      } else {
        for (const s of node.descendantsOfType('export_specifier')) {
          const name = (s.childForFieldName('alias') ?? s.childForFieldName('name'))?.text;
          const local = s.childForFieldName('name')?.text;
          const existing = symbols.find((x) => x.name === local);
          if (existing && name === local) existing.exported = true;
          else if (name) symbols.push({ name, kind: 'const', line: node.startPosition.row + 1, sig: oneLine(node.text, 120), exported: true });
        }
      }
    } else {
      declared(node, false, node, false);
    }
  }
  // Dynamic import() and require() can appear anywhere; a text scan finds them cheaply.
  for (const m of source.matchAll(/(?:\bimport|\brequire)\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
    if (!imports.some((i) => i.spec === m[1])) imports.push({ spec: m[1], names: ['*'], line: source.slice(0, m.index).split('\n').length });
  }
  const schemas = tsSchemas(root);
  const enums: Record<string, string> = {};
  tsTypeSchemas(root, schemas, enums);
  return { symbols, imports, refs: tsRefs(root, symbols, imports), schemas, enums, hints: tsHints(source) };
}

/** The top-level declaration each row belongs to, so a use can be attributed to its enclosing symbol. */
function enclosingOf(root: any): (row: number) => string | undefined {
  const spans: Array<[number, number, string]> = [];
  for (const top of root.children) {
    let node = top;
    if (top.type === 'export_statement') node = top.childForFieldName('declaration') ?? top.namedChildren[top.namedChildren.length - 1] ?? top;
    if (top.type === 'decorated_definition') node = top.childForFieldName('definition') ?? top;
    let name: string | undefined = node?.childForFieldName?.('name')?.text;
    if (!name && node && (node.type === 'lexical_declaration' || node.type === 'variable_declaration')) name = node.namedChildren.find((d: any) => d.type === 'variable_declarator')?.childForFieldName('name')?.text;
    if (!name && top.type === 'export_statement' && top.children.some((c: any) => c.type === 'default')) name = 'default';
    if (name) spans.push([top.startPosition.row, top.endPosition.row, name]);
  }
  return (row) => spans.find(([a, b]) => row >= a && row <= b)?.[2];
}

const DECL_TYPES = new Set(['function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'variable_declarator', 'abstract_class_declaration', 'generator_function_declaration']);

function tsRefs(root: any, symbols: CodeSymbol[], imports: Raw['imports']): CodeRef[] {
  const known = new Set<string>(symbols.filter((x) => x.kind !== 'reexport').map((x) => x.name));
  const namespaces = new Set<string>();
  for (const i of imports) for (const [local, imported] of Object.entries(i.as ?? {})) {
    known.add(local);
    if (imported === '*') namespaces.add(local);
  }
  if (known.size === 0) return [];
  const encl = enclosingOf(root);
  const out = new Map<string, CodeRef>();
  for (const id of root.descendantsOfType(['identifier', 'type_identifier'])) {
    const text: string = id.text;
    if (!known.has(text)) continue;
    const parent = id.parent;
    if (!parent) continue;
    const pt: string = parent.type;
    // Skip the declarations themselves and the import lines.
    if (pt === 'import_specifier' || pt === 'namespace_import' || pt === 'import_clause' || pt === 'export_specifier') continue;
    if (DECL_TYPES.has(pt) && parent.childForFieldName('name')?.id === id.id) continue;
    let name = text;
    let target = id;
    if (namespaces.has(text) && pt === 'member_expression' && parent.childForFieldName('object')?.id === id.id) {
      name = `${text}.${parent.childForFieldName('property')?.text ?? ''}`;
      target = parent;
    }
    const tp = target.parent;
    const called =
      (tp?.type === 'call_expression' && tp.childForFieldName('function')?.id === target.id) ||
      (tp?.type === 'new_expression' && tp.childForFieldName('constructor')?.id === target.id) ||
      tp?.type === 'jsx_opening_element' || tp?.type === 'jsx_self_closing_element';
    const row = id.startPosition.row;
    const where = encl(row);
    if (where === text) continue; // a symbol naming itself inside its own declaration
    const key = `${name}|${where ?? ''}`;
    const prev = out.get(key);
    if (prev) {
      prev.x++;
      if (called) prev.c = 1;
    } else out.set(key, { n: name, l: row + 1, in: where, c: called ? 1 : 0, x: 1 });
  }
  return [...out.values()].slice(0, 600);
}

const DRIZZLE_TYPES: Array<[RegExp, string]> = [
  [/^uuid$/, 'uuid'], [/^(text|varchar|char|citext|inet|cidr|macaddr|time|interval)$/, 'string'],
  [/^(integer|smallint|serial|bigint|bigserial|smallserial|int)$/, 'int'], [/^(numeric|decimal|real|doublePrecision|double)$/, 'float'],
  [/^boolean$/, 'bool'], [/^timestamp$/, 'timestamp'], [/^date$/, 'date'], [/^(json|jsonb)$/, 'json'], [/^vector$/, 'float[]'],
];

function drizzleType(value: string): string {
  const fn = value.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? '';
  let t = DRIZZLE_TYPES.find(([re]) => re.test(fn))?.[1] ?? (/enum/i.test(fn) ? 'string' : 'json');
  if (/\.array\(\)/.test(value)) t = `${t}[]`;
  if (!/\.notNull\(\)|\.primaryKey\(\)/.test(value)) t = `${t}?`;
  return t;
}

function zodType(value: string): string {
  const v = value.replace(/\s+/g, ' ').replace(/\s*\.\s*/g, '.').trim();
  let t = 'json';
  const enumList = v.match(/^z\.enum\(\s*\[([^\]]*)\]/);
  const literal = v.match(/^z\.literal\(\s*["'`]([^"'`]+)["'`]/);
  // z.array(inner)...: find the matching parenthesis so modifiers after it are read separately.
  let arr: [string, string] | null = null;
  let rest = v;
  if (v.startsWith('z.array(')) {
    let depth = 0;
    for (let i = 7; i < v.length; i++) {
      if (v[i] === '(') depth++;
      else if (v[i] === ')' && --depth === 0) {
        arr = [v.slice(0, i + 1), v.slice(8, i)];
        rest = v.slice(i + 1);
        break;
      }
    }
  }
  if (enumList) {
    const items = [...enumList[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    t = items.length ? `enum(${items.join('|')})` : 'string';
  } else if (literal) t = `enum(${literal[1]})`;
  else if (/^z\.string\(/.test(v)) t = /\.uuid\(/.test(v) ? 'uuid' : /\.email\(/.test(v) ? 'email' : /\.url\(/.test(v) ? 'url' : /\.datetime\(|\.date\(/.test(v) ? 'timestamp' : 'string';
  else if (/^z\.(coerce\.)?number\(/.test(v)) t = /\.int\(/.test(v) ? 'int' : 'float';
  else if (/^z\.(coerce\.)?boolean\(/.test(v)) t = 'bool';
  else if (/^z\.(coerce\.)?date\(/.test(v)) t = 'timestamp';
  else if (/^z\.bigint\(/.test(v)) t = 'int';
  else if (/^z\.uuid\(/.test(v)) t = 'uuid';
  else if (/^z\.email\(/.test(v)) t = 'email';
  else if (arr) t = `${zodType(arr[1]).replace(/\?$/, '')}[]`;
  else if (/^z\.record\(/.test(v)) t = 'map<string,json>';
  if (/\.(optional|nullable|nullish)\(\)|\.default\(/.test(rest)) t = `${t.replace(/\?$/, '')}?`;
  return t;
}

function objectFields(obj: any, mapType: (value: string) => string): SchemaField[] {
  const out: SchemaField[] = [];
  for (const p of obj?.namedChildren ?? []) {
    if (p.type === 'pair') {
      const key = String(p.childForFieldName('key')?.text ?? '').replace(/^["'`]|["'`]$/g, '');
      const value = String(p.childForFieldName('value')?.text ?? '');
      if (key) out.push({ name: key, type: mapType(value) });
    } else if (p.type === 'shorthand_property_identifier') out.push({ name: p.text, type: 'json' });
  }
  return out;
}

function tsSchemas(root: any): Record<string, CodeSchema> {
  const out: Record<string, CodeSchema> = {};
  for (const decl of root.descendantsOfType('variable_declarator')) {
    // Top-level declarations only, possibly inside an export.
    let p = decl.parent;
    while (p && (p.type === 'lexical_declaration' || p.type === 'variable_declaration' || p.type === 'export_statement')) p = p.parent;
    if (!p || p.type !== 'program') continue;
    const name = decl.childForFieldName('name')?.text;
    const value = decl.childForFieldName('value');
    if (!name || !value) continue;
    const calls = [value, ...value.descendantsOfType('call_expression')].filter((c: any) => c.type === 'call_expression');
    const drizzle = calls.find((c: any) => /(^|\.)(pgTable|mysqlTable|sqliteTable|table)$/.test(c.childForFieldName('function')?.text ?? '') && c.childForFieldName('arguments')?.namedChildren[0]?.type === 'string');
    if (drizzle) {
      const args = drizzle.childForFieldName('arguments').namedChildren;
      const obj = args.find((a: any) => a.type === 'object');
      if (obj) out[name] = { kind: 'drizzle', table: args[0].text.replace(/^["'`]|["'`]$/g, ''), fields: objectFields(obj, drizzleType) };
      continue;
    }
    const zod = calls.find((c: any) => /^z\.(object|strictObject|looseObject)$/.test((c.childForFieldName('function')?.text ?? '').replace(/\s+/g, '')));
    if (zod) {
      const obj = zod.childForFieldName('arguments')?.namedChildren.find((a: any) => a.type === 'object');
      const fields = obj ? objectFields(obj, zodType) : [];
      const base = value.text.match(/^(\w+)\s*\.\s*(extend|merge)\(/)?.[1];
      if (base && out[base]) fields.unshift(...out[base].fields.filter((f) => !fields.some((x) => x.name === f.name)));
      out[name] = { kind: 'zod', fields };
    }
  }
  return out;
}

function tsType(t: string): string {
  let s = t.replace(/\s+/g, ' ').trim();
  let opt = false;
  if (/\|\s*(null|undefined)\b/.test(s) || /^(null|undefined)\s*\|/.test(s)) {
    opt = true;
    s = s.replace(/\s*\|\s*(null|undefined)\b/g, '').replace(/^(null|undefined)\s*\|\s*/, '').trim();
  }
  let out: string;
  const lits = s.split('|').map((x) => x.trim());
  if (lits.length > 1 && lits.every((x) => /^["'`][^"'`]*["'`]$/.test(x))) out = `enum(${lits.map((x) => x.slice(1, -1)).join('|')})`;
  else if (/^(readonly )?(.+)\[\]$/.test(s)) out = `${tsType(s.replace(/^readonly /, '').slice(0, -2)).replace(/\?$/, '')}[]`;
  else if (/^(Readonly)?Array<(.+)>$/.test(s)) out = `${tsType(s.replace(/^(Readonly)?Array<|>$/g, '')).replace(/\?$/, '')}[]`;
  else if (s === 'string') out = 'string';
  else if (s === 'number') out = 'float';
  else if (s === 'bigint') out = 'int';
  else if (s === 'boolean') out = 'bool';
  else if (s === 'Date') out = 'timestamp';
  else if (/^Record</.test(s)) out = 'map<string,json>';
  else if (/^[A-Z][A-Za-z0-9]*$/.test(s)) out = s;
  else out = 'json';
  return opt ? `${out}?` : out;
}

/** Fields of TypeScript interfaces and object type aliases; string-literal unions and enums go to `enums`. */
function tsTypeSchemas(root: any, out: Record<string, CodeSchema>, enums: Record<string, string>): void {
  for (const top of root.children) {
    const node = top.type === 'export_statement' ? top.childForFieldName('declaration') : top;
    if (!node) continue;
    const name = node.childForFieldName('name')?.text;
    if (name && node.type === 'type_alias_declaration') {
      const lit = tsType(node.childForFieldName('value')?.text ?? '');
      if (lit.startsWith('enum(')) enums[name] = lit;
    }
    if (name && node.type === 'enum_declaration') {
      const vals = (node.childForFieldName('body')?.namedChildren ?? []).map((m: any) => (m.text.match(/=\s*["'`]([^"'`]+)/)?.[1] ?? m.childForFieldName?.('name')?.text ?? m.text.split('=')[0].trim()));
      if (vals.length) enums[name] = `enum(${vals.join('|')})`;
    }
    if (!name || out[name]) continue;
    let body: any = null;
    if (node.type === 'interface_declaration') body = node.childForFieldName('body');
    else if (node.type === 'type_alias_declaration') {
      const v = node.childForFieldName('value');
      if (v?.type === 'object_type') body = v;
    }
    if (!body) continue;
    const fields: SchemaField[] = [];
    for (const m of body.namedChildren) {
      if (m.type !== 'property_signature') continue;
      const key = m.childForFieldName('name')?.text?.replace(/^["']|["']$/g, '');
      const ann = m.childForFieldName('type')?.text?.replace(/^:\s*/, '') ?? 'unknown';
      if (!key) continue;
      const optional = m.children.some((c: any) => c.type === '?');
      const t = tsType(ann);
      fields.push({ name: key, type: optional && !t.endsWith('?') ? `${t}?` : t });
    }
    if (fields.length) out[name] = { kind: 'ts', fields };
  }
}

function tsHints(raw: string): RuntimeHint[] {
  const out: RuntimeHint[] = [];
  // A comment that mentions a route or a path is not code that serves or calls it.
  const source = withoutComments(raw);
  const lineAt = (i: number): number => source.slice(0, i).split('\n').length;
  for (const m of source.matchAll(/\b(?:app|fastify|server|router|instance|api|f|r)\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]*>)?\(\s*["'`](\/[^"'`]*)["'`]/g)) out.push({ k: 'route', v: m[2], op: m[1].toUpperCase(), l: lineAt(m.index ?? 0) });
  for (const m of source.matchAll(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*url\s*:\s*["'`](\/[^"'`]*)["'`]/g)) out.push({ k: 'route', v: m[2], op: m[1], l: lineAt(m.index ?? 0) });
  for (const m of source.matchAll(/["'`]([^"'`\n]*?(\/api\/[A-Za-z0-9_\-/:.${}]+))[^"'`\n]*["'`]/g)) {
    const pathPart = m[2].replace(/\$\{[^}]*\}/g, ':p').replace(/\/+$/, '');
    if (!/\.(ts|js|md)$/.test(pathPart)) out.push({ k: 'http', v: pathPart, l: lineAt(m.index ?? 0) });
  }
  const worker = /Worker\.create\s*\(/.test(source);
  for (const m of source.matchAll(/taskQueue\s*:\s*["'`]([^"'`]+)["'`]/g)) out.push({ k: 'queue', v: m[1], op: worker ? 'consume' : 'start', l: lineAt(m.index ?? 0) });
  for (const m of source.matchAll(/\b(?:workflow\.(?:start|execute|signalWithStart)|startChild|executeChild)\s*\(\s*["'`]?([A-Za-z_]\w*)/g)) out.push({ k: 'workflow', v: m[1], op: 'start', l: lineAt(m.index ?? 0) });
  for (const m of source.matchAll(/\.\s*(from|insert|update|delete|innerJoin|leftJoin|rightJoin|fullJoin)\s*\(\s*([A-Za-z_$][\w$.]*)\s*[),]/g)) {
    out.push({ k: 'table', v: `const:${m[2].split('.').pop()}`, op: /insert|update|delete/.test(m[1]) ? 'write' : 'read', l: lineAt(m.index ?? 0) });
  }
  for (const m of source.matchAll(/\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)([\s\S]{0,160})/g)) {
    out.push({ k: 'table', v: m[1], op: /^\s*\.\s*(insert|upsert|update|delete)\b/.test(m[2]) ? 'write' : 'read', l: lineAt(m.index ?? 0) });
  }
  sqlHints(source, out, lineAt);
  // Files loaded by path rather than imported: they keep their target alive for the reachability scan.
  const entries: RuntimeHint[] = [];
  for (const m of source.matchAll(/workflowsPath\s*:\s*[^\n}]*?["'`](\.{1,2}\/[^"'`\n]+)["'`]/g)) entries.push({ k: 'entry', v: m[1], l: lineAt(m.index ?? 0) });
  for (const m of source.matchAll(/import\.meta\.glob\(\s*(?:\[\s*)?["'`]([^"'`\n]+)["'`]/g)) entries.push({ k: 'entry', v: m[1], l: lineAt(m.index ?? 0) });
  return [...entries, ...dedupeHints(out).slice(0, 300), ...envHints(source, lineAt)];
}

/** Environment variables the code reads by name: process.env, import.meta.env, Deno.env, Bun.env, os.environ, os.getenv. */
function envHints(source: string, lineAt: (i: number) => number): RuntimeHint[] {
  const out: RuntimeHint[] = [];
  const patterns = [
    /\b(?:process|Bun)\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\b(?:process|Bun)\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g,
    /\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\bDeno\.env\.get\(\s*["'`]([A-Z_][A-Z0-9_]*)["'`]/g,
    /\bos\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /\bos\.(?:environ\.get|getenv)\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /\bSystem\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push({ k: 'env', v: m[1], l: lineAt(m.index ?? 0) });
  return dedupeHints(out).slice(0, 60);
}

function dedupeHints(list: RuntimeHint[]): RuntimeHint[] {
  const seen = new Set<string>();
  return list.filter((h) => {
    const key = `${h.k}|${h.v}|${h.op ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Comments blanked out, with every line break kept so line numbers still hold. A block comment is
 * one only outside a string: the slash and star in '/static/*' or "src/**" start nothing.
 */
export function withoutComments(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  const out: string[] = [];
  const n = source.length;
  let kept = 0;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '*' && source[i - 1] !== '\\') {
      const end = source.indexOf('*/', i + 2);
      // Never closed: not a comment this can blank.
      if (end < 0) break;
      out.push(source.slice(kept, i), blank(source.slice(i, end + 2)));
      i = kept = end + 2;
    } else if (c === '/' && source[i + 1] === '/') {
      // A line comment: nothing in it opens a string or a block comment. Whole-line ones are blanked below.
      const eol = source.indexOf('\n', i);
      i = eol < 0 ? n : eol;
    } else if (c === '"' || c === "'" || c === '`') {
      const close = c !== '`' && source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      // A quote left open ends with its line, so an apostrophe in prose does not swallow what follows.
      const oneLine = close.length === 1 && c !== '`';
      let j = i + close.length;
      while (j < n && !source.startsWith(close, j) && !(oneLine && source[j] === '\n')) j += source[j] === '\\' ? 2 : 1;
      i = Math.min(n, source.startsWith(close, j) ? j + close.length : j);
    } else i++;
  }
  out.push(source.slice(kept));
  return out.join('').replace(/^[ \t]*(?:\/\/|#|--).*$/gm, blank);
}

/**
 * Table names in SQL text. Kept as candidates; the compiler keeps only names that are real tables.
 * English prose is full of "from the" and "update them", so a match counts only where it reads as
 * SQL: outside comments, "from" and "join" after a select, update or delete, and "update" before a set.
 */
function sqlHints(source: string, out: RuntimeHint[], lineAt: (i: number) => number): void {
  const text = withoutComments(source);
  for (const m of text.matchAll(/\b(insert\s+into|update|delete\s+from|from|join)\s+(?:"?public"?\.)?("?)([a-z_][a-z0-9_]{2,})"?/gi)) {
    // Table names are lowercase unless quoted; "from Acme Holdings" in a sentence is prose, not SQL.
    if (!m[2] && m[3] !== m[3].toLowerCase()) continue;
    const kw = m[1].toLowerCase();
    const at = m.index ?? 0;
    // The statement so far: back to the last full stop, semicolon or the like, which SQL has none of inside a statement.
    const before = text.slice(Math.max(0, at - 400), at).split(/[.;!?](?=\s|$)/).pop() as string;
    if ((kw === 'from' || kw === 'join') && !/\b(select|update|delete)\b/i.test(before)) continue;
    if (kw === 'update' && !/^[\s\S]{0,200}?\bset\b/i.test(text.slice(at + m[0].length))) continue;
    out.push({ k: 'table', v: m[3].toLowerCase(), op: kw.startsWith('insert') || kw === 'update' || kw.startsWith('delete') ? 'write' : 'read', l: lineAt(at) });
  }
}

const SQL_TYPES: Array<[RegExp, string]> = [
  [/^uuid/, 'uuid'], [/^(text|varchar|character varying|char|citext|inet|cidr|time\b|interval)/, 'string'],
  [/^(int|integer|bigint|smallint|serial|bigserial|int[248])/, 'int'], [/^(numeric|decimal|real|double|float)/, 'float'],
  [/^bool/, 'bool'], [/^timestamp/, 'timestamp'], [/^date/, 'date'], [/^jsonb?/, 'json'], [/^vector/, 'float[]'],
];

function sqlType(def: string): string {
  const d = def.toLowerCase().trim();
  let t = SQL_TYPES.find(([re]) => re.test(d))?.[1] ?? 'string';
  if (/\[\]/.test(d.split(/\s/)[0] ?? '')) t = `${t}[]`;
  if (!/not null|primary key/.test(d)) t = `${t}?`;
  return t;
}

function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** CREATE TABLE and ALTER TABLE steps in a SQL file, in order. */
export function extractSql(source: string): { ops: SqlOp[]; symbols: CodeSymbol[]; hints: RuntimeHint[] } {
  const text = source.replace(/--[^\n]*/g, '');
  const ops: SqlOp[] = [];
  const symbols: CodeSymbol[] = [];
  const lineAt = (i: number): number => text.slice(0, i).split('\n').length;
  const re = /create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]*)"?\s+([^;]+);|create\s+(?:or\s+replace\s+)?(view|function|materialized\s+view)\s+(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
      }
      const fields: SchemaField[] = [];
      for (const part of splitTop(text.slice(start, i - 1))) {
        const p = part.trim().replace(/\s+/g, ' ');
        if (!p || /^(primary key|unique|check|constraint|foreign key|exclude|like)\b/i.test(p)) continue;
        const col = p.match(/^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/i);
        if (col) fields.push({ name: col[1].toLowerCase(), type: sqlType(col[2]) });
      }
      const table = m[1].toLowerCase();
      ops.push({ op: 'create', table, fields });
      symbols.push({ name: table, kind: 'table', line: lineAt(m.index ?? 0), sig: `table ${table} (${fields.length} columns)`, exported: true });
    } else if (m[2]) {
      const table = m[2].toLowerCase();
      for (const action of splitTop(m[3])) {
        const a = action.trim().replace(/\s+/g, ' ');
        const add = a.match(/^add (?:column )?(?:if not exists )?"?([a-z_][a-z0-9_]*)"? (.+)$/i);
        const drop = a.match(/^drop (?:column )?(?:if exists )?"?([a-z_][a-z0-9_]*)"?/i);
        const ren = a.match(/^rename (?:column )?"?([a-z_][a-z0-9_]*)"? to "?([a-z_][a-z0-9_]*)"?/i);
        if (add && !/^(constraint|primary|unique|foreign|check)$/i.test(add[1])) ops.push({ op: 'add', table, fields: [{ name: add[1].toLowerCase(), type: sqlType(add[2]) }] });
        else if (ren) ops.push({ op: 'rename', table, col: ren[1].toLowerCase(), to: ren[2].toLowerCase() });
        else if (drop && !/^(constraint|default|not)$/i.test(drop[1])) ops.push({ op: 'drop', table, col: drop[1].toLowerCase() });
      }
    } else if (m[5]) {
      symbols.push({ name: m[5].toLowerCase(), kind: m[4].toLowerCase().includes('function') ? 'function' : 'table', line: lineAt(m.index ?? 0), sig: `${m[4].toLowerCase()} ${m[5].toLowerCase()}`, exported: true });
    }
  }
  const hints: RuntimeHint[] = [];
  sqlHints(text.replace(/create\s+(?:unlogged\s+)?table[\s\S]*?;/gi, ''), hints, lineAt);
  return { ops, symbols, hints: dedupeHints(hints).slice(0, 200) };
}


function extractPy(root: any, source: string): Raw {
  const symbols: CodeSymbol[] = [];
  const imports: Raw['imports'] = [];
  const schemas: Record<string, CodeSchema> = {};
  for (const top of root.children) {
    const node = top.type === 'decorated_definition' ? top.childForFieldName('definition') ?? top : top;
    const line = top.startPosition.row + 1;
    if (node.type === 'import_statement') {
      for (const n of node.namedChildren) {
        const name = n.type === 'aliased_import' ? n.childForFieldName('name')?.text : n.text;
        if (name) imports.push({ spec: name, names: ['*'], line });
      }
    } else if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name')?.text ?? '';
      const as: Record<string, string> = {};
      const names = node.namedChildren.slice(1).map((n: any) => {
        const name = n.type === 'aliased_import' ? n.childForFieldName('name')?.text : n.text;
        if (name) as[n.type === 'aliased_import' ? n.childForFieldName('alias')?.text ?? name : name] = name;
        return name;
      }).filter(Boolean);
      imports.push({ spec: mod, names: names.length ? names : ['*'], line, as });
    } else if (node.type === 'function_definition' || node.type === 'class_definition') {
      const name = node.childForFieldName('name')?.text;
      if (!name) continue;
      const body = node.childForFieldName('body');
      const first = body?.namedChildren[0];
      const docText = first?.type === 'expression_statement' && first.namedChildren[0]?.type === 'string' ? first.namedChildren[0].text.replace(/^[rRuUbB]*("""|'''|"|')|("""|'''|"|')$/g, '') : undefined;
      symbols.push({
        name,
        kind: node.type === 'class_definition' ? 'class' : 'function',
        line,
        sig: oneLine(node.text, 150).replace(/:\s*$/, ''),
        doc: docText ? oneLine(docText.trim(), 140) : docOf(top),
        exported: !name.startsWith('_'),
      });
      const bases = node.childForFieldName('superclasses')?.text ?? '';
      const decorated = top.type === 'decorated_definition' && /dataclass/.test(top.text.split('\n')[0]);
      if (node.type === 'class_definition' && (/BaseModel|TypedDict|SQLModel|BaseSettings/.test(bases) || decorated)) {
        const fields: SchemaField[] = [];
        for (const st of body?.namedChildren ?? []) {
          const a = st.type === 'expression_statement' ? st.namedChildren[0] : null;
          if (a?.type !== 'assignment') continue;
          const left = a.childForFieldName('left')?.text;
          const ty = a.childForFieldName('type')?.text;
          if (!left || !ty || !/^\w+$/.test(left)) continue;
          const t = pyType(ty);
          fields.push({ name: left, type: a.childForFieldName('right') && !t.endsWith('?') ? `${t}?` : t });
        }
        schemas[name] = { kind: 'pydantic', fields };
      }
    }
  }
  const known = new Set([...symbols.map((x) => x.name), ...imports.flatMap((i) => Object.keys(i.as ?? {}))]);
  const encl = enclosingOf(root);
  const seen = new Map<string, CodeRef>();
  for (const call of root.descendantsOfType('call')) {
    const fn = call.childForFieldName('function');
    const name = fn?.type === 'identifier' ? fn.text : fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : undefined;
    if (!name || !known.has(name)) continue;
    const where = encl(call.startPosition.row);
    const key = `${name}|${where ?? ''}`;
    const prev = seen.get(key);
    if (prev) prev.x++;
    else seen.set(key, { n: name, l: call.startPosition.row + 1, in: where, c: 1, x: 1 });
  }
  const hints: RuntimeHint[] = [];
  const lineAt = (i: number): number => source.slice(0, i).split('\n').length;
  for (const m of withoutComments(source).matchAll(/@\w+\.(get|post|put|patch|delete)\(\s*["'](\/[^"']*)["']/g)) hints.push({ k: 'route', v: m[2], op: m[1].toUpperCase(), l: lineAt(m.index ?? 0) });
  if (/^if\s+__name__\s*==\s*["']__main__["']/m.test(source)) hints.push({ k: 'main', v: '__main__', l: 1 });
  sqlHints(source, hints, lineAt);
  return { symbols, imports, refs: [...seen.values()], schemas, hints: [...dedupeHints(hints).slice(0, 200), ...envHints(withoutComments(source), lineAt)] };
}

function pyType(t: string): string {
  const s = t.replace(/\s+/g, '');
  const opt = /^Optional\[(.+)\]$/.exec(s)?.[1] ?? /^(.+)\|None$/.exec(s)?.[1] ?? /^None\|(.+)$/.exec(s)?.[1];
  if (opt) return `${pyType(opt).replace(/\?$/, '')}?`;
  const list = /^(?:list|List|Sequence|set|Set|tuple|Tuple)\[(.+)\]$/.exec(s)?.[1];
  if (list) return `${pyType(list.split(',')[0]).replace(/\?$/, '')}[]`;
  const lit = /^Literal\[(.+)\]$/.exec(s)?.[1];
  if (lit) return `enum(${lit.split(',').map((x) => x.replace(/^["']|["']$/g, '')).join('|')})`;
  const map: Record<string, string> = { str: 'string', int: 'int', float: 'float', bool: 'bool', datetime: 'timestamp', date: 'date', UUID: 'uuid', uuid: 'uuid', bytes: 'bytes', Decimal: 'float', HttpUrl: 'url', EmailStr: 'email', AnyUrl: 'url' };
  return map[s] ?? 'json';
}


/** The Javadoc right above a Java declaration, as one line without its @tags. */
function javaDocOf(node: any): string | undefined {
  const prev = node.previousSibling;
  if (!prev || prev.type !== 'block_comment' || !String(prev.text).startsWith('/**') || node.startPosition.row - prev.endPosition.row > 1) return undefined;
  const lines = String(prev.text)
    .split('\n')
    .map((l: string) => l.replace(/^\s*(\/\*\*?|\*\/|\*)\s?/, '').replace(/\*\/\s*$/, '').trim())
    .filter((l: string) => l && !l.startsWith('@'))
    .map((l: string) => l.replace(/<[^>]+>/g, '').replace(/\{@\w+\s+([^}]*)\}/g, '$1'));
  return lines.length ? oneLine(lines.join(' '), 140) : undefined;
}

const JAVA_TYPES = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration']);

/** The keywords of a modifiers node, without its annotations. */
function javaModifiers(decl: any): Set<string> {
  const mods = decl.namedChildren?.find((c: any) => c.type === 'modifiers');
  return new Set((mods?.children ?? []).filter((c: any) => !c.type.includes('annotation')).map((c: any) => c.type));
}

function javaType(t: string, enums: Record<string, string>): string {
  const s = t.replace(/\s+/g, '').replace(/^final/, '');
  const opt = /^Optional<(.+)>$/.exec(s)?.[1];
  if (opt) return `${javaType(opt, enums).replace(/\?$/, '')}?`;
  const list = /^(?:List|Set|Collection|Iterable|ArrayList|LinkedList|HashSet|Queue|Deque)<(.+)>$/.exec(s)?.[1];
  if (list) return `${javaType(list, enums).replace(/\?$/, '')}[]`;
  if (s.endsWith('[]')) return `${javaType(s.slice(0, -2), enums).replace(/\?$/, '')}[]`;
  const map = /^(?:Map|HashMap|LinkedHashMap|TreeMap)<(.+),(.+)>$/.exec(s);
  if (map) return `map<${javaType(map[1], enums)},${javaType(map[2], enums)}>`;
  const known: Record<string, string> = {
    String: 'string', char: 'string', Character: 'string', CharSequence: 'string',
    int: 'int', Integer: 'int', long: 'int', Long: 'int', short: 'int', Short: 'int', byte: 'int', Byte: 'int', BigInteger: 'int',
    double: 'float', Double: 'float', float: 'float', Float: 'float', BigDecimal: 'float',
    boolean: 'bool', Boolean: 'bool', UUID: 'uuid', LocalDate: 'date', LocalDateTime: 'timestamp', ZonedDateTime: 'timestamp',
    OffsetDateTime: 'timestamp', Instant: 'timestamp', Date: 'timestamp', URI: 'url', URL: 'url', Object: 'json', JsonNode: 'json', 'byte[]': 'bytes',
  };
  if (known[s]) return known[s];
  if (enums[s]) return enums[s];
  const bare = s.replace(/<.*>$/, '');
  return /^[A-Z]\w*$/.test(bare) ? bare : 'json';
}

/** Lombok and record classes carry their fields in the code; everything else is behaviour. */
const JAVA_DATA_ANNOTATIONS = /@(Data|Value|Builder|Getter|Setter|AllArgsConstructor|NoArgsConstructor|JsonProperty|Jacksonized)\b/;

function extractJava(root: any, source: string): Raw {
  const symbols: CodeSymbol[] = [];
  const imports: Raw['imports'] = [];
  const schemas: Record<string, CodeSchema> = {};
  const enums: Record<string, string> = {};
  const explicit = new Set<string>();
  const beanHints: RuntimeHint[] = [];
  let pkg = '';
  for (const top of root.children) {
    const line = top.startPosition.row + 1;
    if (top.type === 'package_declaration') {
      pkg = top.text.replace(/^package\s+|\s*;\s*$/g, '').trim();
    } else if (top.type === 'import_declaration') {
      const m = /^import\s+(static\s+)?([\w.$]+?)(\.\*)?\s*;/.exec(top.text.replace(/\s+/g, ' '));
      if (!m) continue;
      const [, isStatic, spec, star] = m;
      const last = spec.split('.').pop()!;
      const names = star ? ['*'] : [last];
      if (!star) explicit.add(last);
      // A static import names a member, so it belongs to the class before it; a wildcard one takes the whole class.
      imports.push({ spec: isStatic && !star ? spec.slice(0, -last.length - 1) : spec, names, line, as: star ? undefined : { [last]: last } });
    } else if (JAVA_TYPES.has(top.type)) {
      const name = top.childForFieldName('name')?.text;
      if (!name) continue;
      const mods = javaModifiers(top);
      const exported = mods.has('public');
      const kind: CodeSymbol['kind'] = top.type === 'interface_declaration' ? 'interface' : top.type === 'enum_declaration' ? 'enum' : top.type === 'annotation_type_declaration' ? 'type' : 'class';
      symbols.push({ name, kind, line, sig: signature(top.text), doc: javaDocOf(top), exported });
      const body = top.childForFieldName('body');
      const members: any[] = body?.namedChildren ?? [];
      // A Spring component is wired by the type its users name, so the interface or class it implements or extends
      // is what keeps it alive. An aspect runs by itself.
      const annotations = top.namedChildren?.find((c: any) => c.type === 'modifiers')?.text ?? '';
      if (/@Aspect\b/.test(annotations)) beanHints.push({ k: 'main', v: '@Aspect', l: line });
      if (/@(Component|Service|Repository|Configuration|Controller|RestController|Profile)\b/.test(annotations)) {
        for (const sup of top.namedChildren.filter((c: any) => c.type === 'superclass' || c.type === 'super_interfaces' || c.type === 'extends_interfaces')) {
          const list = sup.type === 'superclass' ? sup.namedChildren : sup.namedChildren.flatMap((c: any) => (c.type === 'type_list' ? c.namedChildren : [c]));
          for (const t of list) {
            const tname = t.type === 'type_identifier' ? t.text : t.namedChildren?.find((c: any) => c.type === 'type_identifier')?.text;
            if (tname) beanHints.push({ k: 'bean', v: tname, op: sup.type === 'superclass' ? 'extends' : 'implements', l: line });
          }
        }
      }
      if (top.type === 'enum_declaration') {
        const constants = members.filter((m) => m.type === 'enum_constant').map((m) => m.childForFieldName('name')?.text).filter(Boolean);
        if (constants.length && constants.length <= 60) enums[name] = `enum(${constants.join('|')})`;
      }
      // Public and protected methods: what the rest of the code calls on this class.
      let count = 0;
      for (const m of members) {
        if (m.type !== 'method_declaration' || count >= 80) continue;
        const mm = javaModifiers(m);
        if (mm.has('private')) continue;
        const mname = m.childForFieldName('name')?.text;
        if (!mname) continue;
        count++;
        symbols.push({
          name: `${name}.${mname}`,
          kind: 'function',
          line: m.startPosition.row + 1,
          sig: signature(m.text).replace(/;$/, ''),
          doc: javaDocOf(m),
          exported: exported && (mm.has('public') || top.type === 'interface_declaration'),
        });
      }
      // Data shapes: records, and classes Lombok or Jackson turn into plain data.
      const annotated = JAVA_DATA_ANNOTATIONS.test(top.text.slice(0, top.text.indexOf(name)));
      if (top.type === 'record_declaration' || (top.type === 'class_declaration' && annotated)) {
        const fields: SchemaField[] = [];
        if (top.type === 'record_declaration') {
          for (const p of top.childForFieldName('parameters')?.namedChildren ?? []) {
            const ty = p.childForFieldName('type')?.text;
            const fname = p.childForFieldName('name')?.text;
            if (ty && fname) fields.push({ name: fname, type: javaType(ty, enums) });
          }
        } else {
          for (const f of members) {
            if (f.type !== 'field_declaration' || javaModifiers(f).has('static')) continue;
            const ty = f.childForFieldName('type')?.text;
            for (const d of f.namedChildren.filter((c: any) => c.type === 'variable_declarator')) {
              const fname = d.childForFieldName('name')?.text;
              if (ty && fname) fields.push({ name: fname, type: javaType(ty, enums) });
            }
          }
        }
        if (fields.length) schemas[name] = { kind: 'java', fields };
      }
    }
  }
  // Classes of the same package need no import line. Each name used that is not declared here, imported, or
  // a type parameter is taken as one; the resolver drops the ones no file matches.
  const own = new Set(symbols.filter((s) => !s.name.includes('.')).map((s) => s.name));
  const used = new Map<string, number>();
  for (const id of root.descendantsOfType(['type_identifier', 'identifier'])) {
    const text: string = id.text;
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(text) || text.length < 2 || own.has(text) || explicit.has(text) || used.has(text)) continue;
    if (id.type === 'identifier') {
      // An identifier counts only where a class name can stand: before a dot (X.of(), X.CONST) or in a static-looking position.
      const p = id.parent;
      const isStatic = (p?.type === 'method_invocation' && p.childForFieldName('object')?.id === id.id) || (p?.type === 'field_access' && p.childForFieldName('object')?.id === id.id);
      if (!isStatic) continue;
    }
    if (id.parent?.type === 'type_parameter') continue;
    used.set(text, id.startPosition.row + 1);
  }
  for (const [name, line] of used) imports.push({ spec: pkg ? `${pkg}.${name}` : name, names: [name], line, as: { [name]: name }, implicit: true });

  // Uses of imported names and own symbols, attributed to the method they sit in.
  const known = new Set<string>([...own, ...explicit]);
  for (const i of imports) for (const n of Object.keys(i.as ?? {})) known.add(n);
  const spans: Array<[number, number, string]> = [];
  for (const top of root.children) {
    if (!JAVA_TYPES.has(top.type)) continue;
    const tname = top.childForFieldName('name')?.text;
    if (!tname) continue;
    spans.push([top.startPosition.row, top.endPosition.row, tname]);
    for (const m of top.childForFieldName('body')?.namedChildren ?? []) {
      if (m.type !== 'method_declaration' && m.type !== 'constructor_declaration') continue;
      const mname = m.childForFieldName('name')?.text;
      if (mname) spans.unshift([m.startPosition.row, m.endPosition.row, `${tname}.${mname}`]);
    }
  }
  const encl = (row: number): string | undefined => spans.find(([a, b]) => row >= a && row <= b)?.[2];
  const refs = new Map<string, CodeRef>();
  for (const id of root.descendantsOfType(['identifier', 'type_identifier'])) {
    const text: string = id.text;
    if (!known.has(text)) continue;
    const p = id.parent;
    if (!p || p.type === 'import_declaration' || p.type === 'scoped_identifier' || p.type === 'package_declaration') continue;
    if (JAVA_TYPES.has(p.type) && p.childForFieldName('name')?.id === id.id) continue;
    const called =
      (p.type === 'method_invocation' && (p.childForFieldName('name')?.id === id.id || p.childForFieldName('object')?.id === id.id)) ||
      (p.type === 'object_creation_expression' && p.childForFieldName('type')?.id === id.id) ||
      p.type === 'superclass' || p.type === 'super_interfaces' || p.type === 'type_list' ||
      (p.type === 'marker_annotation' || p.type === 'annotation') && p.childForFieldName('name')?.id === id.id;
    const row = id.startPosition.row;
    const where = encl(row);
    if (where === text) continue;
    const key = `${text}|${where ?? ''}`;
    const prev = refs.get(key);
    if (prev) {
      prev.x++;
      if (called) prev.c = 1;
    } else refs.set(key, { n: text, l: row + 1, in: where, c: called ? 1 : 0, x: 1 });
  }
  const clean = withoutComments(source);
  const lineAt = (i: number): number => clean.slice(0, i).split('\n').length;
  const hints: RuntimeHint[] = [...beanHints];
  // Paths handed to an HTTP client: the same /api/ rule as for TypeScript.
  for (const m of clean.matchAll(/"([^"\n]*?(\/api\/[A-Za-z0-9_\-/:.{}]+))[^"\n]*"/g)) {
    hints.push({ k: 'http', v: m[2].replace(/\{[^}]*\}/g, ':p').replace(/\/+$/, ''), l: lineAt(m.index ?? 0) });
  }
  sqlHints(clean, hints, lineAt);
  return { symbols, imports, refs: [...refs.values()].slice(0, 600), schemas, enums, hints: [...dedupeHints(hints).slice(0, 200), ...envHints(clean, lineAt)] };
}

const STOP = new Set('the and for with from this that not are was were has have had but its into out all any can will would should could may must use used using via per get set new old true false null undefined async await void string number boolean unknown self def none str int float bool src lib index test tests const let var function export import type interface class return else then when what which who how why also only just like make made more most some such than them they there these those very each other over same where while about after again before being both does doing down during few further here itself once own too until upon'.split(' '));

/** Splits code and prose into lowercase words: camelCase, snake_case and paths all become words. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && w.length < 30 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && /(ed|es)$/.test(w) && !/(ss|us)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

function termsOf(file: string, symbols: CodeSymbol[], source: string): Record<string, number> {
  const t = new Map<string, number>();
  const add = (ws: string[], weight: number): void => {
    for (const w of ws) t.set(w, (t.get(w) ?? 0) + weight);
  };
  add(words(file), 4);
  for (const s of symbols) {
    add(words(s.name), s.exported ? 3 : 2);
    if (s.doc) add(words(s.doc), 1.5);
  }
  const comments = source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"{3}[\s\S]*?"{3}/g) ?? [];
  add(words(comments.join(' ').slice(0, 20000)), 1);
  add(words(source.slice(0, 60000)).slice(0, 4000), 0.25);
  return Object.fromEntries([...t].sort((a, b) => b[1] - a[1]).slice(0, 120).map(([w, n]) => [w, Math.round(n * 100) / 100]));
}

interface Resolver {
  /** files: every file of a package, for a Java wildcard import. */
  (from: string, spec: string, lang: string): { file: string | null; pkg?: string; files?: string[] };
}

function stripJsonComments(text: string): string {
  return text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
}

function makeResolver(root: string, files: Set<string>): Resolver {
  const tryFile = (p: string): string | null => {
    const clean = path.posix.normalize(p).replace(/^\.\//, '').replace(/\/+$/, '');
    if (files.has(clean)) return clean;
    const noExt = clean.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const base of [clean, noExt]) {
      for (const ext of TS_EXT) if (files.has(base + ext)) return base + ext;
      for (const ext of TS_EXT) if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    }
    return null;
  };
  // Workspace packages by name.
  const packages = new Map<string, string>();
  for (const f of files) {
    if (path.posix.basename(f) !== 'package.json' || SKIP.test(`${f}`)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
      if (pkg.name) packages.set(pkg.name, path.posix.dirname(f));
    } catch {
      /* unreadable package.json */
    }
  }
  // tsconfig path aliases, nearest config wins.
  const aliases: Array<{ dir: string; base: string; paths: Array<[string, string[]]> }> = [];
  for (const f of files) {
    if (!/(^|\/)[tj]sconfig(\.[\w-]+)?\.json$/.test(f) || SKIP.test(f)) continue;
    try {
      const cfg = JSON.parse(stripJsonComments(fs.readFileSync(path.join(root, f), 'utf8')));
      const co = cfg.compilerOptions ?? {};
      // baseUrl alone also makes "pkg/a" a path under it.
      if (!co.paths && !co.baseUrl) continue;
      const dir = path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f);
      const paths = Object.entries(co.paths ?? {}) as Array<[string, string[]]>;
      if (co.baseUrl) paths.push(['*', ['*']]);
      aliases.push({ dir, base: path.posix.join(dir, co.baseUrl ?? '.'), paths });
    } catch {
      /* unreadable tsconfig */
    }
  }
  aliases.sort((a, b) => b.dir.length - a.dir.length);
  // Java source roots: the folder a package path hangs from. Maven and Gradle put it at src/<set>/java;
  // anything else is taken from the first segment named java, or the folder above the first package segment.
  const javaRoots = new Set<string>();
  const javaDirs = new Set<string>();
  for (const f of files) {
    if (!f.endsWith('.java') || SKIP.test(`/${f}`)) continue;
    javaDirs.add(path.posix.dirname(f));
    const segs = f.split('/');
    const at = segs.indexOf('java');
    javaRoots.add(at >= 0 && at < segs.length - 1 ? segs.slice(0, at + 1).join('/') : '');
  }
  const roots = [...javaRoots].sort((a, b) => b.length - a.length);

  return (from, spec, lang) => {
    const dir = path.posix.dirname(from);
    if (lang === 'java') {
      const ordered = [...roots.filter((r) => !r || from.startsWith(`${r}/`)), ...roots.filter((r) => r && !from.startsWith(`${r}/`))];
      const at = (root: string, rel: string): string => (root ? `${root}/${rel}` : rel);
      const segs = spec.split('.');
      // a.b.C, then a.b.C.Inner and a.b.C.member fold back onto C.java.
      for (let n = segs.length; n > 0 && n >= segs.length - 2; n--) {
        const rel = `${segs.slice(0, n).join('/')}.java`;
        for (const r of ordered) if (files.has(at(r, rel))) return { file: at(r, rel) };
      }
      for (const r of ordered) {
        const d = at(r, segs.join('/'));
        if (javaDirs.has(d)) return { file: null, files: [...files].filter((f) => f.endsWith('.java') && path.posix.dirname(f) === d).sort() };
      }
      const pkgSegs = [...segs];
      while (pkgSegs.length > 1 && /^[A-Z]/.test(pkgSegs[pkgSegs.length - 1])) pkgSegs.pop();
      return { file: null, pkg: pkgSegs.join('.') };
    }
    if (lang === 'python') {
      const dots = spec.match(/^\.+/)?.[0].length ?? 0;
      const rest = spec.slice(dots).replace(/\./g, '/');
      const tryPy = (base: string): string | null => {
        const p = path.posix.normalize(path.posix.join(base, rest)).replace(/^\.\//, '');
        if (files.has(`${p}.py`)) return `${p}.py`;
        if (files.has(`${p}/__init__.py`)) return `${p}/__init__.py`;
        return null;
      };
      if (dots > 0) {
        let base = dir;
        for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
        return { file: tryPy(base) };
      }
      for (let base = dir; ; base = path.posix.dirname(base)) {
        const hit = tryPy(base === '.' ? '' : base);
        if (hit) return { file: hit };
        if (base === '.' || base === '') break;
      }
      return { file: null, pkg: spec.split('.')[0] };
    }
    if (spec.startsWith('.')) return { file: tryFile(path.posix.join(dir, spec)) };
    for (const a of aliases) {
      if (a.dir && !(from === a.dir || from.startsWith(`${a.dir}/`))) continue;
      for (const [pattern, targets] of a.paths) {
        const star = pattern.indexOf('*');
        const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
        if (star >= 0 ? !spec.startsWith(prefix) : spec !== pattern) continue;
        const tail = star >= 0 ? spec.slice(prefix.length) : '';
        for (const t of targets) {
          const hit = tryFile(path.posix.join(a.base, t.replace('*', tail)));
          if (hit) return { file: hit };
        }
      }
    }
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const pkgDir = packages.get(name);
    if (pkgDir !== undefined) {
      const sub = spec.slice(name.length).replace(/^\//, '');
      const candidates = sub ? [`${pkgDir}/src/${sub}`, `${pkgDir}/${sub}`, `${pkgDir}/lib/${sub}`] : [`${pkgDir}/src/index`, `${pkgDir}/index`, `${pkgDir}/src/main`, `${pkgDir}/lib/index`];
      for (const c of candidates) {
        const hit = tryFile(c);
        if (hit) return { file: hit };
      }
      return { file: null, pkg: name };
    }
    return { file: null, pkg: name.startsWith('node:') ? undefined : name };
  };
}

let runtime: Promise<{ Parser: any; langs: Map<string, any> }> | null = null;
function loadRuntime(): Promise<{ Parser: any; langs: Map<string, any> }> {
  runtime ??= (async () => {
    const require = createRequire(import.meta.url);
    const TS = require('@vscode/tree-sitter-wasm');
    await TS.Parser.init();
    const dir = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
    const langs = new Map<string, any>();
    for (const l of ['typescript', 'tsx', 'javascript', 'python', 'java']) langs.set(l, await TS.Language.load(path.join(dir, `tree-sitter-${l}.wasm`)));
    return { Parser: TS.Parser, langs };
  })();
  return runtime;
}

export interface IndexResult {
  index: CodeIndex;
  parsed: number;
  reused: number;
  files: number;
  ms: number;
}

/** Builds or refreshes the index. Files whose size and modification time are unchanged are not re-read. */
export async function buildCodeIndex(root: string): Promise<IndexResult> {
  const started = Date.now();
  const repo = readRepo(root);
  const all = new Set(repo.files);
  const mdir = MODEL_DIR;
  const wanted = repo.files.filter((f) => LANG_OF[path.extname(f)] && !SKIP.test(`/${f}`) && !f.endsWith('.d.ts') && !/\.min\.js$/.test(f) && !f.startsWith(`${mdir}/`));
  const prior = readCodeIndex(root);
  const old = prior?.extractor === EXTRACTOR ? prior : null;
  const files: Record<string, CodeFile> = {};
  const resolve = makeResolver(root, all);
  let parsed = 0;
  let reused = 0;
  let rt: Awaited<ReturnType<typeof loadRuntime>> | null = null;
  const parsers = new Map<string, any>();
  for (const f of wanted) {
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(root, f));
    } catch {
      continue;
    }
    if (st.size > MAX_BYTES) continue;
    const lang = LANG_OF[path.extname(f)];
    const prev = old?.files[f];
    let entry: Omit<CodeFile, 'path' | 'lang' | 'mtime' | 'size' | 'imports' | 'test'> & { imports: Raw['imports'] };
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
      entry = { ...prev, imports: prev.imports.map((i) => ({ spec: i.spec, names: i.names, line: i.line, as: i.as, implicit: i.implicit })) };
      reused++;
    } else {
      const source = fs.readFileSync(path.join(root, f), 'utf8');
      const lines = source.split('\n').length;
      const hash = createHash('sha1').update(source).digest('hex').slice(0, 12);
      let raw: Raw = { symbols: [], imports: [], refs: [], schemas: {}, hints: [] };
      if (lang === 'sql') {
        const q = extractSql(source);
        raw = { symbols: q.symbols, imports: [], refs: [], schemas: {}, hints: q.hints, sql: q.ops };
      } else {
        rt ??= await loadRuntime();
        let parser = parsers.get(lang);
        if (!parser) {
          parser = new rt.Parser();
          parser.setLanguage(rt.langs.get(lang));
          parsers.set(lang, parser);
        }
        try {
          const tree = parser.parse(source);
          raw = lang === 'python' ? extractPy(tree.rootNode, source) : lang === 'java' ? extractJava(tree.rootNode, source) : extractTs(tree.rootNode, source);
          tree.delete();
        } catch {
          /* unparsable: keep the file with no symbols */
        }
      }
      entry = { lines, hash, ...raw, terms: termsOf(f, raw.symbols, source) };
      parsed++;
    }
    files[f] = {
      ...entry,
      path: f,
      lang,
      mtime: st.mtimeMs,
      size: st.size,
      test: isTestFile(f),
      // A reused entry still holds the submodule imports added last time (names: []); they are added again below.
      imports: entry.imports.filter((i) => !((lang === 'python' || lang === 'java') && i.names.length === 0)).flatMap((i): CodeImport[] => {
        const { files: pkgFiles, ...resolved } = resolve(f, i.spec, lang === 'sql' ? 'typescript' : lang);
        const own = { ...i, ...resolved };
        if (lang === 'java') {
          // A same-package name that matches no file was a type parameter or a library class: not an import.
          if (i.implicit && !own.file) return [];
          // "import a.b.*" loads every class of the package.
          if (pkgFiles) return pkgFiles.filter((x) => x !== f).map((file) => ({ spec: i.spec, names: [] as string[], line: i.line, file }));
          return [own];
        }
        if (lang !== 'python') return [own];
        // "from pkg import mod" loads pkg/mod.py as well as pkg/__init__.py, or mod.py would look like dead code.
        const subs = i.names.filter((n) => n !== '*').map((n) => resolve(f, i.spec.endsWith('.') ? `${i.spec}${n}` : `${i.spec}.${n}`, 'python').file);
        return [own, ...[...new Set(subs)].filter((x): x is string => !!x && x !== own.file).map((file) => ({ spec: i.spec, names: [], line: i.line, file }))];
      }),
    };
  }
  const index: CodeIndex = { version: 3, extractor: EXTRACTOR, builtAt: new Date().toISOString(), files };
  const out = indexPath(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(index));
  return { index, parsed, reused, files: Object.keys(files).length, ms: Date.now() - started };
}

/** How central each file is: a file imported by many important files ranks high. */
export function rankFiles(index: CodeIndex): Map<string, number> {
  const names = Object.keys(index.files);
  const out = new Map<string, string[]>();
  for (const f of names) out.set(f, [...new Set(index.files[f].imports.map((i) => i.file).filter((x): x is string => !!x && x !== f && !!index.files[x]))]);
  let rank = new Map(names.map((f) => [f, 1 / Math.max(1, names.length)]));
  for (let iter = 0; iter < 25; iter++) {
    const next = new Map(names.map((f) => [f, 0.15 / Math.max(1, names.length)]));
    for (const f of names) {
      const targets = out.get(f)!;
      const share = (0.85 * rank.get(f)!) / Math.max(1, targets.length);
      for (const t of targets) next.set(t, next.get(t)! + share);
    }
    rank = next;
  }
  return rank;
}

/** Files that import a given file, with the names they take from it. */
export function importersOf(index: CodeIndex, file: string): Array<{ file: string; names: string[] }> {
  const out: Array<{ file: string; names: string[] }> = [];
  for (const f of Object.values(index.files)) {
    const names = f.imports.filter((i) => i.file === file).flatMap((i) => i.names);
    if (names.length) out.push({ file: f.path, names: [...new Set(names)] });
  }
  return out;
}
