// Local viewer server with live reload, and the single-file static export.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { approveChange } from './approve.js';
import { compile } from './compile.js';
import { changeSecurity } from './security.js';
import { MODEL_DIR } from './paths.js';
import { readDoc } from './docs.js';
import { buildCodeIndex } from './code.js';
import { watchSources } from './watch.js';
import { awaitingApproval, type Graph } from './types.js';

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

/** Adds, to each change that waits for approval, what it does to security: the person reads it before they approve. */
function forReview(graph: Graph): Graph {
  for (const c of graph.changes) {
    if (!awaitingApproval(c)) continue;
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
  const graph = forReview(compile(root, { github, activity: true }));
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

export function serve(root: string, port: number, github: boolean): Promise<string> {
  viewerHtml(); // fail early when the viewer is not built
  const clients = new Set<http.ServerResponse>();
  const token = randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/graph.json') {
      try {
        const graph = forReview(compile(root, { github, activity: true }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(graph));
      } catch (e: any) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
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
      req.on('close', () => clients.delete(res));
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
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write('data: changed\n\n');
    }, 150);
  };
  // Keep the code index fresh while the viewer runs.
  watchSources(root, () => buildCodeIndex(root).then((r) => { if (r.parsed) notify(); }, () => undefined));
  const archAbs = path.join(root, MODEL_DIR);
  try {
    fs.watch(archAbs, { recursive: true }, (_event, file) => {
      if (file && String(file).replace(/\\/g, '/').startsWith('.cache')) {
        if (String(file).includes('reports')) notify();
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
      server.listen(p, '127.0.0.1', () => resolve(`http://localhost:${p}`));
    };
    tryListen(port, 20);
  });
}
