// Local viewer server with live reload, and the single-file static export.
import { noteViewer } from './viewer-open.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { approveChange } from './approve.js';
import { compile } from './compile.js';
import { changeSecurity } from './security.js';
import { MODEL_DIR } from './paths.js';
import { git } from './repo.js';
import { readDoc } from './docs.js';
import { buildCodeIndex, readCodeIndex } from './code.js';
import { watchSources } from './watch.js';
import { awaitingApproval, type Graph } from './types.js';
import { fileDiff, LIVE_FILE, readLive } from './live.js';

function viewerHtml(): string {
  const file = new URL('../viewer/dist/index.html', import.meta.url);
  if (!fs.existsSync(file)) {
    throw new Error('The viewer is not built yet. Run "npm run build" in the Armature repo folder.');
  }
  return fs.readFileSync(file, 'utf8');
}

function embed(html: string, graph: Graph | null, token?: string): string {
  const data = graph ? JSON.stringify(graph).replace(/</g, '\\u003c') : 'null';
  // The token lets this page, and nothing else, ask the server to approve a change. A static export has none.
  const key = token ? `window.__ARMATURE_APPROVE__=${JSON.stringify(token)};` : '';
  return html.replace('</head>', `<script>window.__ARMATURE_GRAPH__=${data};${key}</script></head>`);
}

/** When a change was proposed: the first commit that has its file, or the file's own date while git does not know it. */
export function proposedAt(root: string, id: string): string | undefined {
  for (const ext of ['yaml', 'yml']) {
    const rel = `${MODEL_DIR}/changes/${id}.${ext}`;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    const first = git(root, ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', rel])?.trim().split('\n').pop();
    if (first) return first;
    return (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString();
  }
  return undefined;
}

/** What the code index knows about each listed file: its size, its symbols, and the files of this repo it imports. */
export function fileDetails(graph: Graph, root: string): Graph {
  const idx = readCodeIndex(root);
  if (!graph.files || !idx) return graph;
  for (const list of Object.values(graph.files)) {
    for (const f of list) {
      const c = idx.files[f.path];
      if (!c) continue;
      f.lines = c.lines;
      f.symbols = c.symbols.length;
      if (c.test) f.test = true;
      const imports = [...new Set(c.imports.map((i) => i.file).filter((x): x is string => !!x && x !== f.path))];
      if (imports.length) f.imports = imports;
    }
  }
  return graph;
}

/** Adds, to each change that waits for approval, when it was proposed and what it does to security: the person reads both before they approve. */
function forReview(graph: Graph, root: string): Graph {
  for (const c of graph.changes) {
    if (!awaitingApproval(c)) continue;
    c.proposedAt = proposedAt(root, c.id);
    const sec = changeSecurity(graph, c.id);
    c.security = { lines: sec.lines, errors: sec.errors.map((e) => `${e.code}: ${e.message}`) };
  }
  return graph;
}

/**
 * Approves a change for the person looking at the viewer. Refused unless the request comes from the
 * page this server gave out: its own host and origin, and the token only that page holds.
 */
export function approveFromPage(root: string, token: string, req: Pick<http.IncomingMessage, 'headers'>, body: string): { status: number; ok: boolean; message: string } {
  const host = req.headers.host ?? '';
  const origin = req.headers.origin;
  const sent = Buffer.from(String(req.headers['x-armature-token'] ?? ''));
  const local = /^(?:localhost|127\.0\.0\.1):\d+$/.test(host);
  if (!local || (origin !== undefined && origin !== `http://${host}`) || sent.length !== token.length || !timingSafeEqual(sent, Buffer.from(token))) {
    return { status: 403, ok: false, message: 'Approving is done from the viewer page, by a person.' };
  }
  let id: unknown;
  try {
    id = JSON.parse(body).id;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) return { status: 400, ok: false, message: 'No change named.' };
  const sec = changeSecurity(compile(root), id);
  if (sec.errors.length) {
    return { status: 409, ok: false, message: `Change "${id}" cannot be approved while it has security errors:\n${sec.errors.map((e) => `- ${e.code}: ${e.message}`).join('\n')}` };
  }
  const message = approveChange(root, id);
  const ok = message.startsWith('Approved change');
  return { status: ok ? 200 : 409, ok, message };
}

export function exportHtml(root: string, out: string, github: boolean): string {
  const graph = fileDetails(forReview(compile(root, { github, activity: true, files: true }), root), root);
  graph.root = path.basename(root);
  // A static file has no server to ask, so the document texts travel inside it (up to 12 MB).
  graph.docTexts = {};
  let total = 0;
  for (const d of graph.docs) {
    const text = readDoc(root, d.path);
    if (text === null || total + text.length > 12 * 1024 * 1024) continue;
    graph.docTexts[d.path] = text;
    total += text.length;
  }
  const target = path.resolve(out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, embed(viewerHtml(), graph));
  return target;
}

export function serve(root: string, port: number, github: boolean, opts: { idleMinutes?: number } = {}): Promise<string> {
  viewerHtml(); // fail early when the viewer is not built
  const clients = new Set<http.ServerResponse>();
  // Pages that show the session view: a hook asks whether one is open before it asks the agent to open it.
  const watching = new Set<http.ServerResponse>();
  const token = randomBytes(24).toString('hex');
  let lastSeen = Date.now();
  // The model as last compiled, to say which part owns a file an agent touches. Dropped when the model or the code changes.
  let owners: Graph | null = null;
  const server = http.createServer((req, res) => {
    lastSeen = Date.now();
    // A page on another site can rebind its name to 127.0.0.1, so every route checks the Host, not only /approve.
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(req.headers.host ?? '')) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/graph.json') {
      try {
        const graph = fileDetails(forReview(compile(root, { github, activity: true, files: true }), root), root);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(graph));
      } catch (e: any) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
      return;
    }
    if (url === '/live.json') {
      // What agent sessions are doing right now. Read on every step they take, so it does not compile the model each time.
      let body: string;
      try {
        owners ??= compile(root);
        body = JSON.stringify(readLive(root, owners, Date.now(), { changes: true }));
      } catch {
        body = JSON.stringify({ at: new Date().toISOString(), sessions: [] });
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (url === '/watchers') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ session: watching.size }));
      return;
    }
    if (url === '/diff') {
      // What one file an agent session edited holds that the last commit does not. Other files are refused.
      const file = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '';
      let text: string | null = null;
      try {
        owners ??= compile(root);
        text = fileDiff(root, readLive(root, owners), file);
      } catch {
        text = null;
      }
      res.writeHead(text === null ? 404 : 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text ?? 'Not found');
      return;
    }
    if (url === '/approve') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', () => {
        let out: { status: number; ok: boolean; message: string };
        try {
          out = approveFromPage(root, token, req, body);
        } catch (e: any) {
          out = { status: 500, ok: false, message: String(e?.message ?? e) };
        }
        res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: out.ok, message: out.message }));
      });
      return;
    }
    if (url === '/doc') {
      const file = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '';
      const text = readDoc(root, file);
      res.writeHead(text === null ? 404 : 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text ?? 'Not found');
      return;
    }
    if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      if (new URL(req.url ?? '/', 'http://x').searchParams.get('view') === 'session') watching.add(res);
      req.on('close', () => {
        clients.delete(res);
        watching.delete(res);
        lastSeen = Date.now();
      });
      return;
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(embed(viewerHtml(), null, token));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  let timer: NodeJS.Timeout | null = null;
  const notify = (): void => {
    owners = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write('data: changed\n\n');
    }, 150);
  };
  // A step of an agent session: the page asks for /live.json, not for the whole model again.
  let liveTimer: NodeJS.Timeout | null = null;
  const notifyLive = (): void => {
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      for (const c of clients) c.write('data: live\n\n');
    }, 120);
  };
  // Keep the code index fresh while the viewer runs.
  watchSources(root, () => buildCodeIndex(root).then((r) => { if (r.parsed) notify(); }, () => undefined));
  const archAbs = path.join(root, MODEL_DIR);
  try {
    fs.watch(archAbs, { recursive: true }, (_event, file) => {
      if (file && String(file).replace(/\\/g, '/').startsWith('.cache')) {
        if (String(file).includes('reports')) notify();
        else if (String(file).endsWith(LIVE_FILE)) notifyLive();
        return;
      }
      notify();
    });
  } catch {
    /* live reload is best effort */
  }

  return new Promise((resolve, reject) => {
    const tryListen = (p: number, attempts: number): void => {
      server.once('error', (e: any) => {
        if (e.code === 'EADDRINUSE' && attempts > 0) tryListen(p + 1, attempts - 1);
        else reject(e);
      });
      server.listen(p, '127.0.0.1', () => {
        const url = `http://localhost:${p}`;
        noteViewer(root, url);
        // A viewer started for an approval prompt goes away once nobody has had it open for a while.
        if (opts.idleMinutes && opts.idleMinutes > 0) {
          const idle = opts.idleMinutes * 60 * 1000;
          setInterval(() => {
            if (clients.size === 0 && Date.now() - lastSeen > idle) process.exit(0);
          }, Math.min(idle, 60 * 1000)).unref();
        }
        resolve(url);
      });
    };
    tryListen(port, 20);
  });
}
