// Which code files are alive: reached through imports from an entry point. Entry points are what
// the outside world starts: package scripts and bins, container commands, HTML script tags,
// framework conventions, files Temporal loads by path, tests, and anything the model lists.
// A code file nothing reaches is dead, and the model has to say so (an unused node) or explain it.
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { CodeIndex } from './code.js';
import { isTestFile } from './code.js';
import type { ComposeService } from './deploy.js';

const CODE_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'javascript', 'typescript', 'python', 'java']);
const EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
const FILE_TOKEN = /[\w@.\-/]+\.(?:[cm]?[jt]sx?|py)\b/g;

/** Framework and tooling conventions: files run by a framework or a tool, not imported. */
export const CONVENTION_ENTRIES = [
  '**/routes/**', // file-based routers (TanStack, Remix, SvelteKit)
  '**/app/**/{page,layout,route,loading,error,not-found,template,default}.{ts,tsx,js,jsx}', // Next app router
  '**/pages/**/*.{ts,tsx,js,jsx}', // Next pages router
  '**/{middleware,instrumentation,proxy}.{ts,js}', // Next.js (proxy.ts replaces middleware.ts from Next 16)
  '**/*.config.{ts,js,mjs,cjs,mts,cts}',
  '**/migrations/**',
  '**/scripts/**',
  '**/bin/**',
  '**/{conftest,manage,setup}.py',
];

export interface ReachResult {
  /** Why each entry point counts, for "armature islands --why". */
  entries: Map<string, string>;
  reachable: Set<string>;
  /** Code files no entry point reaches. */
  dead: string[];
}

export interface ReachInput {
  root: string;
  files: string[];
  idx: CodeIndex;
  compose: ComposeService[];
  dockerCommands: Array<{ file: string; command: string }>;
  /** Globs from the model: system and node `entry`. */
  entryGlobs: string[];
}

/** The repo file that declares the supertype a bean is wired by; undefined when the type comes from a library. */
function beanSupertype(f: CodeIndex['files'][string], name: string): string | undefined {
  return f.imports.find((i) => i.file && (i.names.includes(name) || i.file.endsWith(`/${name}.java`)))?.file ?? undefined;
}

export function reach(input: ReachInput): ReachResult {
  const { root, files, idx } = input;
  const known = new Set(Object.keys(idx.files));
  const entries = new Map<string, string>();
  const mark = (f: string | null, why: string): void => {
    if (f && known.has(f) && !entries.has(f)) entries.set(f, why);
  };
  /** A path as written in a command or config, resolved against a directory, trying the usual extensions. */
  const resolveIn = (dir: string, spec: string): string | null => {
    const clean = spec.replace(/^\.\//, '');
    const bases = [path.posix.normalize(path.posix.join(dir, clean))];
    // Built output started in a container usually has its source next to it: dist/x.js -> src/x.ts.
    const fromDist = clean.replace(/^(\.\/)?(dist|build|out)\//, 'src/');
    if (fromDist !== clean) bases.push(path.posix.normalize(path.posix.join(dir, fromDist)));
    for (const b of bases) {
      const noExt = b.replace(/\.[cm]?js$/, '');
      for (const e of EXT) {
        if (known.has(b + e)) return b + e;
        if (known.has(noExt + e)) return noExt + e;
      }
    }
    return null;
  };
  /** A path from a container command: the container's workdir is unknown, so match it as a suffix inside the build context. */
  const resolveSuffix = (dir: string | undefined, spec: string): string[] => {
    const tail = spec.replace(/^\.?\//, '').replace(/^(\.\/)?(dist|build|out)\//, '');
    const tails = [tail, tail.replace(/\.[cm]?js$/, '.ts'), tail.replace(/\.[cm]?js$/, '.tsx')];
    const inDir = (f: string): boolean => !dir || dir === '.' || f.startsWith(`${dir}/`);
    return [...known].filter((f) => inDir(f) && tails.some((t) => f === t || f.endsWith(`/${t}`)));
  };
  const tokens = (cmd: string): string[] => [
    ...[...cmd.matchAll(FILE_TOKEN)].map((m) => m[0]).filter((t) => !t.startsWith('http')),
    // ASGI and WSGI servers name a module, not a file: "uvicorn main:app", "gunicorn pkg.wsgi:app".
    ...[...cmd.matchAll(/\b(?:uvicorn|gunicorn|hypercorn|daphne)\b[^&;|]*?\s([A-Za-z_][\w.]*):[A-Za-z_]\w*/g)].map((m) => `${m[1].replace(/\./g, '/')}.py`),
  ];

  // 1. Tests.
  for (const f of Object.values(idx.files)) if (f.test || isTestFile(f.path)) mark(f.path, 'test');

  // 1b. Java classes a framework loads by name: ServiceLoader registrations (META-INF/services) and AspectJ aspects (aop.xml).
  const javaClass = (name: string): string | null => {
    const tail = `${name.trim().replace(/\./g, '/')}.java`;
    for (const f of known) if (f === tail || f.endsWith(`/${tail}`)) return f;
    return null;
  };
  for (const reg of files.filter((f) => /(^|\/)META-INF\/services\/[^/]+$/.test(f) || /(^|\/)aop\.xml$/.test(f))) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, reg), 'utf8');
    } catch {
      continue;
    }
    const names = reg.endsWith('.xml')
      ? [...text.matchAll(/<(?:aspect|concrete-aspect)\b[^>]*\bname="([\w.$]+)"/g)].map((m) => m[1])
      : text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => /^[\w.$]+$/.test(l));
    for (const n of names) mark(javaClass(n), `registered in ${reg}`);
  }

  // 2. package.json: bins, scripts, and the public entry of packages others install.
  for (const pj of files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules/'))) {
    let pkg: any;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(root, pj), 'utf8'));
    } catch {
      continue;
    }
    const dir = path.posix.dirname(pj);
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
    for (const b of bins) if (typeof b === 'string') mark(resolveIn(dir, b), `bin in ${pj}`);
    for (const [name, script] of Object.entries<any>(pkg.scripts ?? {})) {
      if (typeof script !== 'string') continue;
      for (const t of tokens(script)) mark(resolveIn(dir, t), `script "${name}" in ${pj}`);
    }
    // A private workspace package is reached through its importers; only a published one is an entry by itself.
    if (pkg.private !== true) {
      const walk = (v: unknown): void => {
        if (typeof v === 'string') mark(resolveIn(dir, v), `export of ${pkg.name ?? pj}`);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(pkg.main);
      walk(pkg.module);
      walk(pkg.exports);
    }
  }

  // 3. Containers: compose command and entrypoint, and the CMD of the Dockerfile they build.
  for (const s of input.compose) {
    if (!s.command) continue;
    for (const t of tokens(s.command)) for (const f of resolveSuffix(s.context, t)) mark(f, `container "${s.name}" in ${s.file}`);
  }
  for (const d of input.dockerCommands) {
    for (const t of tokens(d.command)) for (const f of resolveSuffix(path.posix.dirname(d.file), t)) mark(f, `CMD in ${d.file}`);
  }

  // 4. HTML pages load their scripts (Vite and friends).
  for (const html of files.filter((f) => f.endsWith('.html') && !f.includes('node_modules/') && !/(^|\/)(dist|build)\//.test(f))) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, html), 'utf8');
    } catch {
      continue;
    }
    const dir = path.posix.dirname(html);
    for (const m of text.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) mark(resolveIn(dir, m[1].replace(/^\//, '')), `script in ${html}`);
  }

  // 5. Files loaded by path at run time (workflowsPath, import.meta.glob), and Python scripts.
  for (const f of Object.values(idx.files)) {
    for (const h of f.hints ?? []) {
      if (h.k === 'main') mark(f.path, h.v === '__main__' ? 'runs as a script (__main__)' : h.v === 'main()' ? 'has a main method' : `started by the framework (${h.v})`);
      if (h.k !== 'entry') continue;
      const dir = path.posix.dirname(f.path);
      if (/[*{]/.test(h.v)) {
        const m = picomatch(path.posix.normalize(path.posix.join(dir, h.v)), { dot: true });
        for (const k of known) if (m(k)) mark(k, `import.meta.glob in ${f.path}`);
      } else mark(resolveIn(dir, h.v), `loaded by path from ${f.path}`);
    }
  }

  // 6. Conventions and the model's own list.
  const conv = picomatch(CONVENTION_ENTRIES, { dot: true });
  const listed = input.entryGlobs.length ? picomatch(input.entryGlobs, { dot: true }) : null;
  for (const f of known) {
    if (listed?.(f)) mark(f, 'listed as an entry in the model');
    else if (conv(f)) mark(f, 'framework or tooling convention');
  }

  // 5b. A bean that implements or extends a library type (CommandLineRunner, Filter, Converter) is called by the
  // framework through that type, so nobody in the repo names it.
  for (const f of Object.values(idx.files)) {
    for (const h of f.hints ?? []) {
      if (h.k !== 'bean' || beanSupertype(f, h.v)) continue;
      mark(f.path, `wired by the framework as a ${h.v} (a library type)`);
    }
  }

  // Walk the import graph from every entry.
  const reachable = new Set<string>();
  const walk = (from: Iterable<string>): void => {
    const queue = [...from];
    while (queue.length) {
      const f = queue.pop()!;
      if (reachable.has(f)) continue;
      reachable.add(f);
      for (const i of idx.files[f]?.imports ?? []) if (i.file && !reachable.has(i.file)) queue.push(i.file);
    }
  };
  walk(entries.keys());
  // A bean a framework wires by type (a Spring component) is named nowhere: its users name the interface or
  // class it implements. It is alive when that supertype is, and what it imports is alive with it.
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of Object.values(idx.files)) {
      if (reachable.has(f.path)) continue;
      for (const h of f.hints ?? []) {
        if (h.k !== 'bean') continue;
        const sup = beanSupertype(f, h.v);
        if (!sup || !reachable.has(sup)) continue;
        mark(f.path, `wired by the framework as a ${h.v} (${sup})`);
        walk([f.path]);
        grew = true;
        break;
      }
    }
  }
  const dead = Object.values(idx.files)
    .filter((f) => CODE_LANGS.has(f.lang) && !reachable.has(f.path) && !f.path.endsWith('.d.ts'))
    .map((f) => f.path)
    .sort();
  return { entries, reachable, dead };
}
