import { useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import type { Change, DocInfo, DocLink, DocRef, Graph } from '../../src/types.ts';
import { refIndexOf, resolveRef as resolveModelRef } from '../../src/refs.ts';
import type { Index } from './view.ts';

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s: string): string => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Raw HTML in a document is shown as text, never run.
const md = new Marked({ gfm: true });
md.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${slug(inner)}">${inner}</h${depth}>\n`;
    },
  },
  // [[node.id]], [[node#interface]], [[Shape]] and [[ref|label]] name parts of the model. Code is left alone.
  extensions: [
    {
      name: 'archRef',
      level: 'inline',
      start(src: string) {
        const i = src.indexOf('[[');
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^\[\[\s*([A-Za-z0-9][A-Za-z0-9_.#:-]*)\s*(?:\|([^[\]\n]*))?\]\]/.exec(src);
        return m ? { type: 'archRef', raw: m[0], ref: m[1], label: (m[2] ?? '').trim() } : undefined;
      },
      renderer(token) {
        return `<a class="ref" href="model:${escapeHtml(token.ref)}">${escapeHtml(token.label || token.ref)}</a>`;
      },
    },
  ],
});

/** Resolves a reference written in a document with the compiler's own resolver. */
export function resolveRef(graph: Graph, text: string): Omit<DocRef, 'text' | 'count'> | null {
  const r = resolveModelRef(refIndexOf(graph), text);
  return r ? { type: r.type, id: r.id, node: r.node } : null;
}

/** What a document says about itself in one line: its computed plan status, or the status typed in it. */
function DocStatus({ doc }: { doc: DocInfo }) {
  if (doc.state) return <div className="s"><b>Plan:</b> {doc.state}</div>;
  if (doc.status) return <div className="s"><b>Status:</b> {doc.status}</div>;
  return null;
}

const RANK: Record<DocLink['how'], number> = { declared: 3, inside: 2, mentions: 1 };
const HOW_LABEL: Record<DocLink['how'], string> = { declared: 'named in the model', inside: 'inside its code', mentions: 'mentions its code' };

export interface DocEntry {
  doc: DocInfo;
  how: DocLink['how'];
  count: number;
  /** The node, at or below the one asked about, that the link goes to. */
  via: string;
}

/** Documents about a node and everything inside it, strongest link first. */
export function docsFor(graph: Graph, ix: Index, id: string | null): DocEntry[] {
  const byPath = new Map(graph.docs.map((d) => [d.path, d]));
  const best = new Map<string, DocEntry>();
  const nodes = id === null ? graph.nodes : graph.nodes.filter((n) => n.id === id || n.id.startsWith(`${id}.`));
  for (const n of nodes) {
    for (const l of n.docs) {
      const doc = byPath.get(l.path);
      if (!doc) continue;
      const prev = best.get(l.path);
      if (!prev) best.set(l.path, { doc, how: l.how, count: l.count, via: n.id });
      else {
        prev.count += l.count;
        if (RANK[l.how] > RANK[prev.how] || (RANK[l.how] === RANK[prev.how] && n.id === id)) {
          prev.how = l.how;
          prev.via = n.id;
        }
      }
    }
  }
  if (id === null) for (const d of graph.docs) if (!best.has(d.path)) best.set(d.path, { doc: d, how: 'mentions', count: 0, via: '' });
  void ix;
  return [...best.values()].sort((a, b) => RANK[b.how] - RANK[a.how] || b.count - a.count || a.doc.path.localeCompare(b.doc.path));
}

/** Changes that touch a node or anything inside it. */
export function changesFor(graph: Graph, id: string | null): Change[] {
  if (id === null) return graph.changes;
  const inside = (x: string): boolean => x === id || x.startsWith(`${id}.`);
  return graph.changes.filter((c) =>
    c.nodes.some(inside) || c.interfaces.some((r) => inside(r.split('#')[0])) || c.requirements.some((r) => inside(r.split(':')[0])) || c.edges.some((e) => e.split('>').some((p) => inside(p.split('#')[0]))));
}

function Pill({ kind, children }: { kind: string; children?: React.ReactNode }) {
  return <span className={`pill ${kind}`}>{children ?? kind}</span>;
}

export function DocRow({ e, onOpen, active }: { e: DocEntry; onOpen: (p: string) => void; active?: boolean }) {
  return (
    <button className={`row docrow ${active ? 'on' : ''}`} onClick={() => onOpen(e.doc.path)}>
      <div className="t">{e.doc.title} {e.doc.kind && <Pill kind="dockind">{e.doc.kind}</Pill>}</div>
      <div className="mono s">{e.doc.path}</div>
      <DocStatus doc={e.doc} />
      {e.doc.summary && <div className="s">{e.doc.summary}</div>}
      <div className="s muted">{e.doc.words.toLocaleString()} words{e.count > 0 && e.via ? ` · ${HOW_LABEL[e.how]}${e.via ? ` (${e.via})` : ''}` : ''}</div>
    </button>
  );
}

/** Plans and documents for the side panel of a node (or the whole system when id is null). */
export function DocsBlock({ graph, ix, id, openDoc }: { graph: Graph; ix: Index; id: string | null; openDoc: (p: string) => void }) {
  const [all, setAll] = useState(false);
  const plans = changesFor(graph, id);
  const entries = useMemo(() => docsFor(graph, ix, id), [graph, ix, id]);
  const planDocs = new Set(plans.map((c) => c.doc).filter(Boolean) as string[]);
  const about = entries.filter((e) => !planDocs.has(e.doc.path) && e.how !== 'mentions');
  const mentions = entries.filter((e) => !planDocs.has(e.doc.path) && e.how === 'mentions' && e.count > 0);
  if (!plans.length && !entries.length) return null;
  const LIMIT = 6;
  return (
    <>
      {plans.length > 0 && (
        <>
          <h3>Plans ({plans.length})</h3>
          <ul className="list">
            {plans.map((c) => {
              const doc = graph.docs.find((d) => d.path === c.doc);
              return (
                <li key={c.id}>
                  <div><b>{c.title}</b> <Pill kind={c.state} /></div>
                  {c.why && <div className="small" style={{ marginTop: 3 }}>{c.why}</div>}
                  {c.doneWhen.length > 0 && <div className="small muted" style={{ marginTop: 3 }}>Done when: {c.doneWhen.join(' ')}</div>}
                  {doc && <button className="btn" style={{ marginTop: 6 }} onClick={() => openDoc(doc.path)}>Read the plan: {doc.title} ({doc.words.toLocaleString()} words)</button>}
                  {c.doc && !doc && <div className="mono small muted">{c.doc} (not found)</div>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {about.length > 0 && (
        <>
          <h3>Documents ({about.length})</h3>
          {(all ? about : about.slice(0, LIMIT)).map((e) => <DocRow key={e.doc.path} e={e} onOpen={openDoc} />)}
        </>
      )}
      {mentions.length > 0 && (
        <>
          <h3>Mentioned in ({mentions.length})</h3>
          {(all ? mentions : mentions.slice(0, LIMIT)).map((e) => <DocRow key={e.doc.path} e={e} onOpen={openDoc} />)}
        </>
      )}
      {(about.length > LIMIT || mentions.length > LIMIT) && (
        <button className="btn" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${about.length + mentions.length} documents`}</button>
      )}
    </>
  );
}

/** The Docs lens: every document in the repo, searchable, grouped by folder. */
export function Library({ graph, ix, focus, selected, openDoc }: { graph: Graph; ix: Index; focus: string | null; selected: string | null; openDoc: (p: string) => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'plans' | 'view' | 'unlinked'>('all');
  const entries = useMemo(() => docsFor(graph, ix, null), [graph, ix]);
  const inView = useMemo(() => new Set(focus ? docsFor(graph, ix, focus).map((e) => e.doc.path) : graph.docs.map((d) => d.path)), [graph, ix, focus]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries.filter((e) => {
    const d = e.doc;
    if (filter === 'plans' && !(d.kind === 'plan' || d.changes.length || /plan/i.test(d.path))) return false;
    if (filter === 'view' && !inView.has(d.path)) return false;
    if (filter === 'unlinked' && !d.loose) return false;
    if (!words.length) return true;
    const hay = `${d.title} ${d.path} ${d.summary} ${d.outline.join(' ')} ${d.links.map((l) => l.node).join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const groups = new Map<string, DocEntry[]>();
  for (const e of shown.sort((a, b) => a.doc.path.localeCompare(b.doc.path))) {
    const parts = e.doc.path.split('/');
    const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '(root)';
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const [open, setOpen] = useState<Set<string>>(new Set());
  const total = graph.docs.length;
  return (
    <aside className="panel">
      <h2>Docs</h2>
      <p className="small">{total} documents in the repo: {graph.docs.filter((d) => d.model).length} with a header that ties them to the model, {graph.docs.filter((d) => d.loose).length} tied to nothing yet. Pick one to read it and to light up the parts it is about.</p>
      <input className="search" type="search" placeholder="Search titles, paths, headings, nodes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />
      <div className="btnrow" style={{ marginTop: 8 }}>
        {([['all', 'All'], ['plans', 'Plans'], ['view', focus ? 'In this view' : 'Linked'], ['unlinked', 'Not in the model']] as const).map(([k, label]) => (
          <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      <p className="small muted">{shown.length} shown</p>
      {[...groups].map(([folder, list]) => {
        const expanded = open.has(folder) || words.length > 0 || groups.size <= 3 || list.some((e) => e.doc.path === selected);
        return (
          <div key={folder} className="docgroup">
            <button className="docgroup-head" onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(folder)) n.delete(folder); else n.add(folder); return n; })} aria-expanded={expanded}>
              <span>{expanded ? '▾' : '▸'} {folder}</span><span className="muted">{list.length}</span>
            </button>
            {expanded && list.slice(0, 60).map((e) => (
              <button key={e.doc.path} className={`row docrow ${selected === e.doc.path ? 'on' : ''}`} onClick={() => openDoc(e.doc.path)}>
                <div className="t">{e.doc.title} {e.doc.kind && <Pill kind="dockind">{e.doc.kind}</Pill>}</div>
                <div className="mono s">{e.doc.path.slice(folder === '(root)' ? 0 : folder.length + 1)}</div>
                <DocStatus doc={e.doc} />
                <div className="s muted">{e.doc.words.toLocaleString()} words{e.doc.links.length ? ` · ${e.doc.links.length} node${e.doc.links.length === 1 ? '' : 's'}` : ''}{e.doc.changes.length ? ` · plan for ${e.doc.changes.join(', ')}` : ''}</div>
              </button>
            ))}
            {expanded && list.length > 60 && <p className="small muted">… {list.length - 60} more; search to narrow.</p>}
          </div>
        );
      })}
    </aside>
  );
}

/** A document, rendered, over the left part of the map. */
export function Reader({ graph, path, onClose, openDoc, goTo, openRef }: { graph: Graph; path: string; onClose: () => void; openDoc: (p: string) => void; goTo: (id: string) => void; openRef: (r: Omit<DocRef, 'text' | 'count'>) => void }) {
  const doc = graph.docs.find((d) => d.path === path);
  const [text, setText] = useState<string | null>(graph.docTexts?.[path] ?? null);
  const [err, setErr] = useState<string | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setErr(null);
    if (graph.docTexts) {
      setText(graph.docTexts[path] ?? null);
      if (!(path in graph.docTexts)) setErr('This document was too large to include in the exported file.');
      return;
    }
    setText(null);
    let live = true;
    fetch(`/doc?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((t) => live && setText(t))
      .catch((e) => live && setErr(`Could not load it (${e.message}).`));
    return () => {
      live = false;
    };
  }, [graph, path]);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const html = useMemo(() => {
    if (text === null) return '';
    let out = md.parse(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')) as string;
    // The header already shows the title, so a first heading that repeats it is left out.
    const h1 = /^\s*<h1[^>]*>([\s\S]*?)<\/h1>\s*/.exec(out);
    if (h1 && doc && h1[1].replace(/<[^>]+>/g, '').trim().toLowerCase() === doc.title.trim().toLowerCase()) out = out.slice(h1[0].length);
    // A reference that names nothing in the model is shown as broken, not as a dead link.
    return out.replace(/<a class="ref" href="model:([^"]*)"/g, (m, ref: string) => (resolveRef(graph, ref.replace(/&amp;/g, '&')) ? m : `<a class="ref broken" title="Not in the model" href="model:${ref}"`));
  }, [text, graph, doc]);
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const onClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    e.preventDefault();
    if (href.startsWith('model:')) {
      const hit = resolveRef(graph, href.slice(6));
      if (hit) openRef(hit);
      return;
    }
    if (href.startsWith('#')) {
      body.current?.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^(https?|mailto):/i.test(href)) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    if (/^[a-z]+:/i.test(href)) return;
    const [target] = href.split('#');
    const parts = (dir ? `${dir}/${target}` : target).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    const resolved = out.join('/');
    if (graph.docs.some((d) => d.path === resolved)) openDoc(resolved);
  };
  const changes = doc ? graph.changes.filter((c) => doc.changes.includes(c.id)) : [];
  // Shapes, flows and changes the document names: nodes are already in the chips from its links.
  const others = doc ? doc.refs.filter((r) => r.type === 'shape' || r.type === 'flow' || (r.type === 'change' && !doc.changes.includes(r.id))) : [];
  return (
    <div className="reader" role="dialog" aria-label={doc?.title ?? path}>
      <div className="reader-head">
        <div style={{ minWidth: 0 }}>
          <div className="reader-title">{doc?.title ?? path} {doc?.kind && <Pill kind="dockind">{doc.kind}</Pill>}</div>
          <div className="mono small muted" style={{ overflowWrap: 'anywhere' }}>{path}{doc ? ` · ${doc.words.toLocaleString()} words` : ''}</div>
        </div>
        <button className="btn" onClick={onClose} aria-label="Close the document">Close</button>
      </div>
      {doc && (doc.links.length > 0 || changes.length > 0 || others.length > 0 || doc.broken.length > 0) && (
        <div className="reader-links">
          {changes.map((c) => <button key={c.id} className={`pill ${c.state}`} onClick={() => openRef({ type: 'change', id: c.id })} title={doc.state}>Plan for {c.title} · {c.state}</button>)}
          {doc.links.slice(0, 14).map((l) => (
            <button key={l.node} className="chip" onClick={() => goTo(l.node)} title={HOW_LABEL[l.how]}>{l.node}</button>
          ))}
          {others.slice(0, 10).map((r) => (
            <button key={`${r.type} ${r.id}`} className="chip" onClick={() => openRef(r)} title={r.type}>{r.id}</button>
          ))}
          {doc.links.length > 14 && <span className="small muted">+{doc.links.length - 14} more</span>}
          {doc.broken.length > 0 && <span className="chip warn" title="Named in the document, not in the model">{doc.broken.length} broken: {doc.broken.slice(0, 3).join(', ')}{doc.broken.length > 3 ? ', …' : ''}</span>}
        </div>
      )}
      <div className="reader-scroll" ref={body} onClick={onClick}>
        <div className="reader-grid">
          {doc && doc.outline.length > 1 && (
            <nav className="reader-outline" aria-label="Sections">
              <div className="reader-outline-head">On this page</div>
              {doc.outline.map((h) => <a key={h} href={`#${slug(h)}`} onClick={(e) => { e.preventDefault(); body.current?.querySelector(`#${CSS.escape(slug(h))}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{h}</a>)}
            </nav>
          )}
          <article className="reader-body md">
            {err && <p className="small" style={{ color: 'var(--red)' }}>{err}</p>}
            {text === null && !err && <p className="muted">Loading…</p>}
            {/* The HTML comes from marked with raw HTML escaped. */}
            <div dangerouslySetInnerHTML={{ __html: html }} />
          </article>
        </div>
      </div>
    </div>
  );
}
