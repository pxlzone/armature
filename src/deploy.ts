// Reads how the system is deployed: docker compose files and Dockerfiles. The result ties
// containers to nodes and gives the reachability scan the commands containers start with.
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import YAML from 'yaml';

export interface ComposeService {
  name: string;
  file: string;
  /** dev, prod, staging… from the file name; "base" for docker-compose.yml. */
  env: string;
  image?: string;
  /** Command, entrypoint, and the CMD/ENTRYPOINT of the Dockerfile it builds from, as one line. */
  command?: string;
  /** Directory the build runs in, relative to the repo root. */
  context?: string;
  dockerfile?: string;
}

export interface Dockerfile {
  file: string;
  from: string[];
  command?: string;
}

export const DEFAULT_COMPOSE = ['**/docker-compose*.{yml,yaml}', '**/compose*.{yml,yaml}'];

export function envOf(file: string): string {
  const base = path.basename(file).replace(/\.ya?ml$/, '').replace(/^(docker-)?compose/, '');
  return base.replace(/^[.-]/, '') || 'base';
}

const asLine = (v: unknown): string | undefined => (Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : undefined);

export function readDockerfile(root: string, file: string): Dockerfile | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
  const from: string[] = [];
  const cmd: string[] = [];
  // Join continuation lines so a CMD split over lines reads as one.
  for (const line of text.replace(/\\\r?\n/g, ' ').split('\n')) {
    const m = line.trim().match(/^(FROM|CMD|ENTRYPOINT|RUN)\s+(.*)$/i);
    if (!m) continue;
    const verb = m[1].toUpperCase();
    if (verb === 'FROM') from.push(m[2].split(/\s+/)[0]);
    else if (verb === 'CMD' || verb === 'ENTRYPOINT') {
      let arg = m[2].trim();
      try {
        if (arg.startsWith('[')) arg = (JSON.parse(arg) as string[]).join(' ');
      } catch {
        /* shell form */
      }
      cmd.push(arg);
    }
  }
  return { file, from, command: cmd.join(' ') || undefined };
}

/** Every service in every compose file, with the Dockerfile command folded in when the service builds one. */
export function readCompose(root: string, files: string[], globs: string[] = DEFAULT_COMPOSE): ComposeService[] {
  const isCompose = picomatch(globs, { dot: true });
  const fileSet = new Set(files);
  const out: ComposeService[] = [];
  const dockerfiles = new Map<string, Dockerfile | null>();
  const docker = (f: string): Dockerfile | null => {
    if (!dockerfiles.has(f)) dockerfiles.set(f, fileSet.has(f) ? readDockerfile(root, f) : null);
    return dockerfiles.get(f)!;
  };
  for (const file of files.filter((f) => isCompose(f) && !f.includes('node_modules/'))) {
    let doc: any;
    try {
      doc = YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch {
      continue;
    }
    const services = doc?.services;
    if (!services || typeof services !== 'object') continue;
    const dir = path.dirname(file);
    for (const [name, raw] of Object.entries<any>(services)) {
      const s = raw ?? {};
      const build = typeof s.build === 'string' ? { context: s.build } : s.build ?? null;
      const context = build?.context ? path.posix.normalize(path.posix.join(dir, build.context)) : undefined;
      const dockerfile = build ? path.posix.normalize(path.posix.join(context ?? dir, build.dockerfile ?? 'Dockerfile')) : undefined;
      const fromDocker = dockerfile ? docker(dockerfile)?.command : undefined;
      const command = [asLine(s.entrypoint), asLine(s.command), fromDocker].filter(Boolean).join(' ') || undefined;
      out.push({ name, file, env: envOf(file), image: typeof s.image === 'string' ? s.image : undefined, command, context, dockerfile });
    }
  }
  return out;
}

/** Commands from Dockerfiles that no compose file builds, so their entry points still count. */
export function looseDockerCommands(root: string, files: string[], used: Set<string>): Array<{ file: string; command: string }> {
  const out: Array<{ file: string; command: string }> = [];
  for (const f of files) {
    if (!/(^|\/)Dockerfile[^/]*$/.test(f) || used.has(f)) continue;
    const d = readDockerfile(root, f);
    if (d?.command) out.push({ file: f, command: d.command });
  }
  return out;
}
