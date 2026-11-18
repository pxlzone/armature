// Local viewer server with live reload, and the single-file static export.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { compile } from './compile.js';
import { MODEL_DIR } from './paths.js';
import { readDoc } from './docs.js';
import { buildCodeIndex } from './code.js';
import { watchSources } from './watch.js';
import type { Graph } from './types.js';

function viewerHtml(): string {
  const file = new URL('../viewer/dist/index.html', import.meta.url);
  if (!fs.existsSync(file)) {
    throw new Error('The viewer is not built yet. Run "npm run build" in the Armature repo folder.');
  }
  return fs.readFileSync(file, 'utf8');
}

function embed(html: string, graph: Graph | null): string {
  const data = graph ? JSON.stringify(graph).replace(/</g, '\\u003c') : 'null';
  return html.replace('</head>', `<script>window.__ARMATURE_GRAPH__=${data};</script></head>`);
}

export function exportHtml(root: string, out: string, github: boolean): string {
  const graph = compile(root, { github, activity: true });
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
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/graph.json') {
      try {
        const graph = compile(root, { github, activity: true });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(graph));
      } catch (e: any) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
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
      res.end(embed(viewerHtml(), null));
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
