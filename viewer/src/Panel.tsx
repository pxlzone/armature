import { useState } from 'react';
import type { ActivityItem, Change, Coverage, Edge, GNode, Graph, Interface, Problem, Requirement, Shape } from '../../src/types.ts';
import { GROUP_TITLE, WARNING_INFO } from '../../src/types.ts';
import type { Index, View } from './view.ts';
import { DocsBlock, Library } from './Docs.tsx';
import type { Lens, Selection } from './App.tsx';

interface Props {
  graph: Graph;
  ix: Index;
  view: View | null;
  lens: Lens;
  sel: Selection;
  setSel: (s: Selection) => void;
  showProblems: boolean;
  focus: string | null;
  expanded: Set<string>;
  toggle: (id: string, on?: boolean) => void;
  activityType: string | null;
  setActivityType: (t: string | null) => void;
  open: (id: string) => void;
  goTo: (id: string) => void;
  flowId: string | null;
  setFlow: (id: string | null) => void;
  step: number;
  setStep: (s: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  shapeId: string | null;
  setShape: (id: string | null) => void;
  pickShape: (id: string) => void;
  changeId: string | null;
  setChange: (id: string | null) => void;
  isInside: (id: string, anc: string) => boolean;
  docPath: string | null;
  openDoc: (p: string) => void;
}

function Pill({ kind, children }: { kind: string; children?: React.ReactNode }) {
  return <span className={`pill ${kind}`}>{children ?? kind}</span>;
}

const ShapesContext = { all: new Map<string, Shape>() };

function typeRefs(type: string): string[] {
  return (type.replace(/enum\([^)]*\)/g, '').match(/[A-Z][A-Za-z0-9]*/g) ?? []).filter((t) => ShapesContext.all.has(t));
}

function FieldRows({ shape, depth }: { shape: Shape; depth: number }) {
  const [openField, setOpenField] = useState<string | null>(null);
  return (
    <>
      <table>
        <tbody>
          {shape.fields.map((f) => {
            const refs = depth < 3 ? typeRefs(f.type) : [];
            return (
              <tr key={f.name}>
                <td>{f.name}</td>
                <td>
                  {refs.length ? <button className="linkish mono" onClick={() => setOpenField(openField === f.name ? null : f.name)} aria-expanded={openField === f.name}>{f.type}</button> : f.type}
                  {f.tags.map((t) => <span key={t} className="tag">@{t}</span>)}
                  {openField === f.name && refs.map((r) => (
                    <div className="nest" key={r}><FieldRows shape={ShapesContext.all.get(r)!} depth={depth + 1} /></div>
                  ))}
                </td>
              </tr>
            );
          })}
          {shape.fields.length === 0 && <tr><td colSpan={2}>No fields listed yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function ShapeCard({ shape, startOpen, onTrace }: { shape: Shape; startOpen?: boolean; onTrace?: () => void }) {
  const [open, setOpen] = useState(startOpen ?? false);
  return (
    <div className="fields">
      <div className="fh" onClick={() => setOpen(!open)} role="button" aria-expanded={open}>
        <span>{open ? '▾' : '▸'} {shape.id}</span>
        {shape.stale ? <Pill kind="stale" /> : shape.source ? <Pill kind={shape.bound ? 'verified' : 'unverified'}>{shape.bound ? 'bound to code' : 'unconfirmed'}</Pill> : <Pill kind="planned">draft</Pill>}
        {shape.change && <Pill kind="planned">{shape.change}</Pill>}
      </div>
      {open && (
        <>
          <FieldRows shape={shape} depth={0} />
          <div style={{ padding: '6px 10px' }} className="small muted">
            {shape.note && <div>{shape.note}</div>}
            {shape.source && <div className="mono">{shape.source}</div>}
            {onTrace && <button className="btn" style={{ marginTop: 6 }} onClick={onTrace}>Show where it travels</button>}
          </div>
        </>
      )}
    </div>
  );
}

const TYPE_ORDER = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'ci'];
function typeClass(t: string): string {
  return TYPE_ORDER.includes(t) ? `t-${t}` : 't-other';
}

function TypeBar({ byType }: { byType: Record<string, number> }) {
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, c]) => n + c, 0) || 1;
  return (
    <div className="typebar" role="img" aria-label={entries.map(([t, c]) => `${t} ${c}`).join(', ')}>
      {entries.map(([t, c]) => <span key={t} className={typeClass(t)} style={{ width: `${(c / total) * 100}%` }} title={`${t}: ${c}`} />)}
    </div>
  );
}

function ItemRow({ it }: { it: ActivityItem }) {
  return (
    <li>
      <span className="mono muted">{it.date.slice(0, 10)}</span>{' '}
      <span className={`dot ${typeClass(it.type)}`} />
      <span className="mono">{it.type}{it.scope ? `(${it.scope})` : ''}{it.breaking ? '!' : ''}</span>{' '}
      {it.kind === 'pr' && <Pill kind={it.state === 'open' ? 'approved' : it.state === 'merged' ? 'verified' : 'unverified'}>{it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.id}</a> : it.id} {it.state}</Pill>}
      <div>{it.title}</div>
    </li>
  );
}

function ActivityBlock({ n }: { n: GNode }) {
  const a = n.activity;
  if (!a) return null;
  const max = Math.max(1, ...a.weeks);
  return (
    <>
      <h3>Activity</h3>
      <p className="small">{a.commits} commit{a.commits === 1 ? '' : 's'}, {a.prsOpen} open and {a.prsMerged} merged pull request{a.prsMerged === 1 ? '' : 's'}, {a.authors} author{a.authors === 1 ? '' : 's'}.</p>
      <TypeBar byType={a.byType} />
      <div className="spark" role="img" aria-label={`Items per week, oldest first: ${a.weeks.join(', ')}`}>{a.weeks.map((w, i) => <span key={i} style={{ height: `${(w / max) * 100}%` }} title={`${w}`} />)}</div>
      <ul className="list small">{a.recent.slice(0, 8).map((it) => <ItemRow key={it.kind + it.id} it={it} />)}</ul>
    </>
  );
}

function AskAgent({ subject, file }: { subject: string; file?: string }) {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const prompt = `In the architecture model, about ${subject}${file ? ` (${file})` : ''}: ${text.trim() || '<describe the change>'}\n\nUpdate the model files to match, keep ids stable, then run "armature check" and fix what it reports.`;
  return (
    <>
      <h3>Ask the agent</h3>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setCopied(false); }} placeholder="Describe what should change here. The diagram is read-only; the agent edits the files." aria-label="Request for the agent" />
      <div className="btnrow">
        <button
          className="btn primary"
          onClick={() => {
            const done = (): void => setCopied(true);
            if (navigator.clipboard?.writeText) navigator.clipboard.writeText(prompt).then(done, done);
            else done();
          }}
        >
          {copied ? 'Copied. Paste it into Claude Code' : 'Copy prompt'}
        </button>
      </div>
    </>
  );
}

function ReqItem({ q }: { q: Requirement }) {
  return (
    <li>
      <Pill kind={q.state} /> {q.change && <Pill kind="planned">{q.change}</Pill>}
      <div>{q.text}</div>
      {q.outdated && <div className="small muted">It passed, but in a test report older than the code. Run the tests again.</div>}
      {q.covers.length > 0 && <div className="small muted">Covers <span className="mono">{q.covers.join(', ')}</span></div>}
      <div className="mono muted">[req {q.ref}]</div>
    </li>
  );
}

function IfaceItem({ i, shapes, pickShape }: { i: Interface; shapes: Map<string, Shape>; pickShape: (id: string) => void }) {
  return (
    <li>
      <div className="mono">
        <b>{i.id}</b> {i.via && <span className="muted">via {i.via}</span>} {i.status !== 'built' && <Pill kind={i.status} />}
        {i.modify && <> <Pill kind="building">changing: {i.modify}</Pill></>}
        {i.evidence === 'unseen' && i.status === 'built' && <> <Pill kind="stale">not in code</Pill></>}
      </div>
      {(i.route || i.queue) && <div className="mono muted">{i.route ?? `queue ${i.queue}`}{i.dlq ? `, dead letters to ${i.dlq}` : ''}</div>}
      {i.note && <div className="small muted">{i.note}</div>}
      {[...i.takes.map((s) => ['takes', s]), ...i.gives.map((s) => ['gives', s])].map(([dir, s]) => {
        const sh = shapes.get(s);
        return sh ? (
          <div key={dir + s}>
            <span className="small muted">{dir}</span>
            <ShapeCard shape={sh} onTrace={() => pickShape(s)} />
          </div>
        ) : null;
      })}
    </li>
  );
}

export function Panel(p: Props) {
  const { graph, ix, view, lens, sel } = p;
  const [todoKind, setTodoKind] = useState<'all' | 'task' | 'debt' | 'bug' | 'idea'>('all');
  const shapes = new Map(graph.shapes.map((s) => [s.id, s]));
  ShapesContext.all = shapes;

  if (p.showProblems) {
    return (
      <aside className="panel">
        <h2>Checks</h2>
        <p className="muted small">What <span className="mono">armature check</span> reports for this model. Errors break the model and fail CI. Warnings never block: <b>wrong</b> means the model disagrees with the code, so fix those first; <b>incomplete</b> means it leaves something out.</p>
        {graph.coverage && graph.coverage.files > 0 && <CoverageBlock c={graph.coverage} dead={graph.dead.length} />}
        {graph.problems.length === 0 && <p>No problems.</p>}
        <ProblemGroup title="Errors: the model is broken" tone="error" list={graph.problems.filter((x) => x.level === 'error')} open />
        <ProblemGroup title={GROUP_TITLE.wrong} tone="wrong" list={graph.problems.filter((x) => x.level === 'warning' && x.group === 'wrong')} open />
        <ProblemGroup title={GROUP_TITLE.incomplete} tone="incomplete" list={graph.problems.filter((x) => x.level === 'warning' && x.group !== 'wrong')} />
      </aside>
    );
  }

  if (sel?.type === 'node') {
    const n = ix.nodes.get(sel.id);
    if (n) return <NodePanel {...p} n={n} shapes={shapes} />;
  }
  if (sel?.type === 'edge' && view) {
    const m = view.edges.find((e) => e.id === sel.id);
    if (m) {
      const a = ix.nodes.get(m.from)!;
      const b = ix.nodes.get(m.to)!;
      return (
        <aside className="panel">
          <h2>{a.name} → {b.name}</h2>
          <p className="muted small">{m.edges.length === 1 ? 'One link.' : `${m.edges.length} links merged at this zoom level.`} Arrows point the way the data moves.</p>
          {m.codeKind && <p className="small">These are imports between the two nodes' code, not declared data links.</p>}
          {m.edges.map((e) => (e.code ? <CodeDepCard key={e.id} graph={graph} from={e.from} to={e.to} /> : <EdgeCard key={e.id} e={e} shapes={shapes} pickShape={p.pickShape} />))}
          <AskAgent subject={`the link from \`${m.from}\` to \`${m.to}\``} />
        </aside>
      );
    }
  }

  if (lens === 'flow') {
    const flow = graph.flows.find((f) => f.id === p.flowId) ?? null;
    return (
      <aside className="panel">
        <h2>Flows</h2>
        <p className="muted small">A flow is one story told across the diagram. Pick one, then play it.</p>
        {graph.flows.length === 0 && <p>No flows yet. Add one under {graph.system.dir}/flows/.</p>}
        {graph.flows.map((f) => (
          <button key={f.id} className={`row ${f.id === p.flowId ? 'on' : ''}`} onClick={() => p.setFlow(f.id === p.flowId ? null : f.id)}>
            <div className="t">{f.title} {f.change && <Pill kind="planned">planned</Pill>}</div>
            <div className="s">{f.headline}</div>
          </button>
        ))}
        {flow && (
          <>
            <div className="flow-head">
              <h3>{flow.title}: steps</h3>
              <button className="btn" onClick={() => p.setFlow(null)} title="Clear the flow and show the whole map (Esc)">Close ✕</button>
            </div>
            {flow.trigger && <p className="small muted">Starts when: {flow.trigger}</p>}
            <div className="btnrow">
              <button className="btn primary" onClick={() => p.setPlaying(!p.playing)}>{p.playing ? 'Pause' : 'Play'}</button>
              <button className="btn" onClick={() => p.setStep(-1)}>Show whole flow</button>
            </div>
            <ol className="steps">
              {flow.steps.map((s, i) => {
                const e = s.edge ? ix.edges.get(s.edge) : undefined;
                const hidden = view && e && !view.edges.some((m) => m.edges.some((x) => x.id === e.id));
                const inner = hidden ? commonParent(ix, s.from, s.to) : null;
                return (
                  <li key={i}>
                    <button className={i === p.step ? 'on' : ''} onClick={() => p.setStep(i)}>
                      <span>
                        <span className="mono">{ix.nodes.get(s.from)?.name ?? s.from} → {ix.nodes.get(s.to)?.name ?? s.to}</span>
                        {e && !s.reply && e.shapes.length > 0 && <span className="mono muted"> · {e.shapes.join(', ')}</span>}
                        {e && s.reply && <span className="mono muted"> · {e.returns.join(', ') || 'answer'} (reply)</span>}
                        {s.note && <div className="note">{s.note}</div>}
                        {inner && <div className="note">Happens inside {ix.nodes.get(inner)?.name}. <a href="#" onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); p.toggle(inner, true); }}>Expand it</a></div>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </aside>
    );
  }

  if (lens === 'data') {
    const cur = p.shapeId ? shapes.get(p.shapeId) : undefined;
    const carriers = cur ? graph.edges.filter((e) => e.shapes.includes(cur.id) || e.returns.includes(cur.id)) : [];
    return (
      <aside className="panel">
        <h2>Data</h2>
        <p className="muted small">Pick a shape to see every link and node it touches. Fields marked <span className="tag" style={{ marginLeft: 0 }}>@pii</span> hold personal data.</p>
        {cur && (
          <>
            <h3>Selected</h3>
            <ShapeCard shape={cur} startOpen key={cur.id} />
            <p className="small muted">{carriers.length ? `Travels on ${carriers.length} link${carriers.length === 1 ? '' : 's'}:` : 'Not carried by any link yet.'}</p>
            <ul className="list">
              {carriers.map((e) => <li key={e.id} className="mono">{e.from} → {e.to}{e.status !== 'built' ? ` (${e.status})` : ''}</li>)}
            </ul>
            <div className="btnrow"><button className="btn" onClick={() => p.setShape(null)}>Clear</button></div>
          </>
        )}
        <h3>All shapes ({graph.shapes.length})</h3>
        {graph.shapes.map((s) => (
          <button key={s.id} className={`row ${s.id === p.shapeId ? 'on' : ''}`} onClick={(ev) => { p.setShape(s.id === p.shapeId ? null : s.id); ev.currentTarget.closest('.panel')?.scrollTo({ top: 0 }); }}>
            <span className="mono t">{s.id}</span>{' '}
            {s.stale ? <Pill kind="stale" /> : !s.source ? <Pill kind="planned">draft</Pill> : null}
            {s.fields.some((f) => f.tags.includes('pii')) && <span className="tag">@pii</span>}
            <div className="s">{s.fields.length} field{s.fields.length === 1 ? '' : 's'}{s.source ? ` · ${s.source.split('#')[0].split('/').pop()}` : ''}</div>
          </button>
        ))}
      </aside>
    );
  }

  if (lens === 'tests') {
    const reqs = graph.nodes.flatMap((n) => n.requirements);
    const verified = reqs.filter((q) => q.state === 'verified').length;
    const failing = reqs.filter((q) => q.state === 'failing');
    const noReports = graph.system.reports.junit === 0 && graph.system.reports.lcov === 0;
    return (
      <aside className="panel">
        <h2>Tests</h2>
        {noReports ? (
          <p className="small"><b>No test or coverage report found.</b> Run the tests with a JUnit reporter and put the files in <span className="mono">{graph.system.dir}/.cache/reports/</span> (JUnit <span className="mono">*.xml</span>, coverage <span className="mono">*.info</span>). Until then every requirement shows as unverified.</p>
        ) : (
          <p className="muted small">{graph.system.reports.junit} JUnit and {graph.system.reports.lcov} coverage report{graph.system.reports.lcov === 1 ? '' : 's'} read.</p>
        )}
        <h3>Requirements</h3>
        <p>{verified} of {reqs.length} verified{failing.length ? `, ${failing.length} failing` : ''}.</p>
        <div className="bar"><div style={{ width: `${reqs.length ? (verified / reqs.length) * 100 : 0}%` }} /></div>
        <ul className="list" style={{ marginTop: 10 }}>
          {[...reqs].sort((a, b) => rank(a.state) - rank(b.state)).map((q) => <ReqItem key={q.ref} q={q} />)}
        </ul>
      </aside>
    );
  }

  if (lens === 'work') {
    const rankOf = { high: 0, medium: 1, low: 2 } as const;
    const allTodos = graph.nodes.flatMap((n) => n.todos).filter((t) => p.focus === null || p.isInside(t.node, p.focus));
    const todos = allTodos.filter((t) => todoKind === 'all' || t.kind === todoKind).sort((x, y) => rankOf[x.priority] - rankOf[y.priority] || x.node.localeCompare(y.node));
    const prs = new Map<number, { title: string; url: string; nodes: string[] }>();
    for (const n of graph.nodes) for (const pr of n.prs) {
      const e = prs.get(pr.number) ?? { title: pr.title, url: pr.url, nodes: [] };
      e.nodes.push(n.id);
      prs.set(pr.number, e);
    }
    return (
      <aside className="panel">
        <h2>Work</h2>
        <p className="muted small">A change groups planned elements. Pick one to light it up. A person approves a change before an agent implements it.</p>
        {graph.changes.length === 0 && <p>No changes yet. Add one under {graph.system.dir}/changes/.</p>}
        {graph.changes.map((c) => <ChangeRow key={c.id} c={c} on={c.id === p.changeId} onClick={() => p.setChange(c.id === p.changeId ? null : c.id)} onRead={c.doc && graph.docs.some((d) => d.path === c.doc) ? () => p.openDoc(c.doc as string) : undefined} />)}
        <h3>Open pull requests</h3>
        {!graph.system.hasRemote ? <p className="small muted">This repo has no git remote, so there are no pull requests to show.</p> : prs.size === 0 ? <p className="small muted">None found touching modelled code. Start the viewer with <span className="mono">--github</span> to load them.</p> : (
          <ul className="list">
            {[...prs].map(([num, pr]) => (
              <li key={num}><a href={pr.url} target="_blank" rel="noreferrer">#{num}</a> {pr.title}<div className="mono muted">{pr.nodes.join(', ')}</div></li>
            ))}
          </ul>
        )}
        <h3>Next tasks and tech debt ({allTodos.length}{p.focus ? ' in this view' : ''})</h3>
        <div className="btnrow" style={{ marginTop: 0, marginBottom: 6 }}>
          {(['all', 'debt', 'task', 'bug', 'idea'] as const).map((k) => {
            const count = k === 'all' ? allTodos.length : allTodos.filter((t) => t.kind === k).length;
            return count > 0 || k === 'all' ? (
              <button key={k} className={`chip ${todoKind === k ? 'on' : ''}`} onClick={() => setTodoKind(k)}>
                {k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)} {count}
              </button>
            ) : null;
          })}
        </div>
        {todos.length === 0 && <p className="small muted">Nothing noted. Add <span className="mono">todos:</span> to a node file.</p>}
        <ul className="list">
          {todos.map((t, i) => (
            <li key={i}>
              <Pill kind={t.kind === 'bug' ? 'failing' : t.kind === 'debt' ? 'stale' : 'unverified'}>{t.kind}</Pill>{' '}
              {t.priority !== 'medium' && <Pill kind={t.priority === 'high' ? 'failing' : 'unverified'}>{t.priority}</Pill>}{' '}
              <a href="#" className="mono" onClick={(e) => { e.preventDefault(); p.goTo(t.node); }}>{t.node}</a>
              <div>{t.text}</div>
              {(t.owner || t.issue || t.change) && <div className="small muted">{[t.owner && `Owner: ${t.owner}`, t.issue && `Issue #${t.issue}`, t.change && `Change ${t.change}`].filter(Boolean).join(' · ')}</div>}
            </li>
          ))}
        </ul>
      </aside>
    );
  }

  if (lens === 'activity') {
    const a = graph.activity;
    if (!a) {
      return (
        <aside className="panel">
          <h2>Activity</h2>
          <p>No commit history was read. This view needs a git repository.</p>
        </aside>
      );
    }
    const types = Object.entries(a.byType).sort((x, y) => y[1] - x[1]);
    const count = (n: GNode): number => (p.activityType ? n.activity?.byType[p.activityType] ?? 0 : n.activity ? n.activity.commits + n.activity.prsOpen + n.activity.prsMerged + n.activity.prsClosed : 0);
    const rows = graph.nodes.filter((n) => n.children.length === 0 && count(n) > 0 && (p.focus === null || p.isInside(n.id, p.focus))).sort((x, y) => count(y) - count(x));
    const max = Math.max(1, ...rows.map(count));
    return (
      <aside className="panel">
        <h2>Activity</h2>
        <p className="small">Last {a.days} days: <b>{a.commits}</b> commits{a.prsLoaded ? <>, <b>{a.prs}</b> pull requests</> : null}. {a.conventional} of {a.commits} commit subjects follow Conventional Commits.</p>
        {!a.prsLoaded && <p className="small muted">Pull requests are not loaded. {graph.system.hasRemote ? <>Start the viewer with <span className="mono">--github</span> to add them.</> : 'This repo has no git remote.'}</p>}
        <p className="small muted">An item counts for a node when it changed that node's files, or when its scope, as in <span className="mono">fix(scope): …</span>, names the node. Darker tiles are busier.</p>
        <h3>By type</h3>
        <TypeBar byType={a.byType} />
        <div className="btnrow" style={{ marginTop: 6 }}>
          <button className={`chip ${p.activityType === null ? 'on' : ''}`} onClick={() => p.setActivityType(null)}>All</button>
          {types.slice(0, 8).map(([t, c]) => (
            <button key={t} className={`chip ${p.activityType === t ? 'on' : ''}`} onClick={() => p.setActivityType(p.activityType === t ? null : t)}><span className={`dot ${typeClass(t)}`} />{t} {c}</button>
          ))}
        </div>
        <h3>Busiest nodes{p.activityType ? `: ${p.activityType}` : ''}{p.focus ? ' in this view' : ''}</h3>
        <ul className="list">
          {rows.slice(0, 25).map((n) => (
            <li key={n.id}>
              <a href="#" className="mono" onClick={(e) => { e.preventDefault(); p.goTo(n.id); }}>{n.id}</a> <b>{count(n)}</b>
              {!p.activityType && n.activity && n.activity.prsOpen > 0 && <span className="small muted"> · {n.activity.prsOpen} open PR</span>}
              <div className="bar"><div style={{ width: `${(count(n) / max) * 100}%`, background: 'var(--heat)' }} /></div>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="small muted">Nothing matched.</p>}
        {a.unmatchedScopes.length > 0 && (
          <>
            <h3>Scopes that match no node</h3>
            <p className="small">{a.unmatchedScopes.map((u) => `${u.scope} (${u.count})`).join(', ')}</p>
            <p className="small muted">Add <span className="mono">scopes: [name]</span> to a node file to claim one.</p>
          </>
        )}
      </aside>
    );
  }

  if (lens === 'docs') return <Library graph={graph} ix={ix} focus={p.focus} selected={p.docPath} openDoc={p.openDoc} />;

  if (lens === 'code') {
    if (!graph.code) {
      return (
        <aside className="panel">
          <h2>Code</h2>
          <p>No code index was found. Run <span className="mono">armature index</span> in the project, then reload.</p>
        </aside>
      );
    }
    const scoped = graph.codeDeps.filter((d) => p.focus === null || p.isInside(d.from, p.focus) || p.isInside(d.to, p.focus));
    const und = scoped.filter((d) => d.kind === 'undeclared');
    return (
      <aside className="panel">
        <h2>Code</h2>
        <p className="small">{graph.code.files} files and {graph.code.symbols} top-level symbols are indexed. The map now shows what the code imports, node to node, instead of the declared data links.</p>
        <ul className="list small">
          <li><b>{scoped.filter((d) => d.kind === 'declared').length}</b> match a link the model declares (solid).</li>
          <li><b>{scoped.filter((d) => d.kind === 'library').length}</b> go to shared libraries (dotted).</li>
          <li><b style={{ color: 'var(--red)' }}>{und.length}</b> are undeclared: the code depends on something the model does not show (red, dashed).</li>
        </ul>
        <h3>Undeclared dependencies ({und.length})</h3>
        {und.length === 0 && <p className="small muted">None. The model and the imports agree.</p>}
        {und.map((d) => <CodeDepCard key={`${d.from}>${d.to}`} graph={graph} from={d.from} to={d.to} goTo={p.goTo} />)}
        <p className="small muted" style={{ marginTop: 12 }}>Agents read the same index with <span className="mono">armature map</span>, <span className="mono">armature symbol</span> and <span className="mono">armature deps</span>.</p>
      </aside>
    );
  }

  if (lens === 'rules') {
    const sysRules = graph.nodes[0]?.rules.filter((r) => r.from === 'system') ?? [];
    const own = graph.nodes.filter((n) => n.ownRules > 0);
    return (
      <aside className="panel">
        <h2>Rules</h2>
        <p className="muted small">Guidance for whoever edits a node's code. Child nodes inherit their parents' rules, and each node's rules load in Claude Code when it touches that node's files.</p>
        <h3>Whole system</h3>
        <ul className="list">{sysRules.map((r, i) => <li key={i}>{r.text}</li>)}</ul>
        {sysRules.length === 0 && <p className="small muted">None.</p>}
        {own.map((n) => (
          <div key={n.id}>
            <h3><a href="#" onClick={(e) => { e.preventDefault(); p.goTo(n.id); }}>{n.id}</a></h3>
            <ul className="list">{n.rules.filter((r) => r.from === n.id).map((r, i) => <li key={i}>{r.text}</li>)}</ul>
          </div>
        ))}
      </aside>
    );
  }

  // Structure lens, nothing selected.
  const scope = graph.nodes.filter((n) => n.children.length === 0 && (p.focus === null || p.isInside(n.id, p.focus)));
  const counts = new Map<string, number>();
  for (const n of scope) counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
  const focusNode = p.focus ? ix.nodes.get(p.focus) : null;
  return (
    <aside className="panel">
      <h2>{focusNode ? focusNode.name : graph.system.name}</h2>
      <p>{focusNode ? focusNode.description ?? focusNode.role : graph.system.description ?? graph.system.headline}</p>
      {!focusNode && graph.snapshot?.commit && (
        <p className="small muted">Snapshot of <span className="mono">{graph.snapshot.commit}</span>{graph.snapshot.branch ? ` on ${graph.snapshot.branch}` : ''}{graph.snapshot.dirty ? ', with uncommitted changes' : ''}, {graph.snapshot.at.slice(0, 16).replace('T', ' ')}.</p>
      )}
      <h3>Status of {scope.length} node{scope.length === 1 ? '' : 's'}</h3>
      <ul className="list">
        {(['verified', 'built', 'building', 'planned', 'stale', 'failing', 'retiring'] as const).filter((s) => counts.get(s)).map((s) => (
          <li key={s}><Pill kind={s} /> <b>{counts.get(s)}</b> <span className="muted small">{scope.filter((n) => n.status === s).map((n) => n.name).join(', ')}</span></li>
        ))}
      </ul>
      <DocsBlock graph={graph} ix={ix} id={p.focus} openDoc={p.openDoc} />
      <h3>Reading the diagram</h3>
      <ul className="list small">
        <li>Arrows point the way the data moves. The label is the data shape.</li>
        <li>A dashed, unfilled tile or a dashed line is planned and not built yet. "Built today" hides them.</li>
        <li>A stacked tile has nodes inside. Double-click it, or press its plus, to expand it in place.</li>
        <li>Hover a node to see only what it talks to.</li>
        <li>Click any node or line for its details and data fields.</li>
      </ul>
      {graph.system.branch && <p className="small muted" style={{ marginTop: 14 }}>Branch <span className="mono">{graph.system.branch}</span>. Model read {new Date(graph.generatedAt).toLocaleTimeString()}.</p>}
    </aside>
  );
}

function rank(s: string): number {
  return s === 'failing' ? 0 : s === 'unverified' ? 1 : 2;
}

function commonParent(ix: Index, a: string, b: string): string | null {
  const pa = a.split('.');
  const pb = b.split('.');
  const out: string[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i] === pb[i]; i++) out.push(pa[i]);
  const id = out.join('.');
  return id && ix.nodes.has(id) ? id : null;
}

function CodeDepCard({ graph, from, to, goTo }: { graph: Graph; from: string; to: string; goTo?: (id: string) => void }) {
  const all = graph.codeDeps.filter((x) => x.from === from && x.to === to);
  if (!all.length) return null;
  return <>{all.map((d) => <CodeDepOne key={d.via ?? 'import'} d={d} goTo={goTo} />)}</>;
}

function CodeDepOne({ d, goTo }: { d: Graph['codeDeps'][number]; goTo?: (id: string) => void }) {
  const link = (id: string) => (goTo ? <a href="#" onClick={(e) => { e.preventDefault(); goTo(id); }}>{id}</a> : <b>{id}</b>);
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
      <div className="mono">{link(d.from)} {(d.via ?? 'import') === 'import' ? 'imports from' : d.via === 'table' ? 'uses a table of' : d.via === 'http' ? 'calls over HTTP' : d.via === 'queue' ? 'sends jobs to' : 'starts workflows on'} {link(d.to)}</div>
      <div className="small muted">{d.count} {(d.via ?? 'import') === 'import' ? `import${d.count === 1 ? '' : 's'}` : `use${d.count === 1 ? '' : 's'} in code`} · <Pill kind={d.kind === 'undeclared' ? 'failing' : d.kind === 'declared' ? 'verified' : 'unverified'}>{d.kind}</Pill></div>
      {d.samples.map((s, i) => (
        <div key={i} className="mono small" style={{ marginTop: 4 }}>{s.from}<br /><span className="muted">takes {s.names.join(', ') || '*'} from {s.to}</span></div>
      ))}
    </div>
  );
}

function ChangeRow({ c, on, onClick, onRead }: { c: Change; on: boolean; onClick: () => void; onRead?: () => void }) {
  const pr = c.progress;
  const total = pr.total + pr.reqTotal;
  const done = pr.built + pr.reqVerified;
  return (
    <button className={`row ${on ? 'on' : ''}`} onClick={onClick}>
      <div className="t">{c.title}</div>
      <div className="s">
        <Pill kind={c.state} />{' '}
        {pr.total > 0 && `${pr.built}/${pr.total} nodes have code`}{pr.total > 0 && pr.reqTotal > 0 && ' · '}{pr.reqTotal > 0 && `${pr.reqVerified}/${pr.reqTotal} requirements verified`}
      </div>
      {total > 0 && <div className="bar"><div style={{ width: `${(done / total) * 100}%` }} /></div>}
      {on && (
        <div className="s" style={{ marginTop: 6 }}>
          {c.why && <div>{c.why}</div>}
          {c.doneWhen.length > 0 && <div style={{ marginTop: 4 }}>Done when: {c.doneWhen.join(' ')}</div>}
          {c.doc && <div className="mono" style={{ marginTop: 4 }}>{c.doc}</div>}
          {onRead && <span role="button" tabIndex={0} className="btn" style={{ display: 'inline-block', marginTop: 6 }} onClick={(e) => { e.stopPropagation(); onRead(); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onRead(); } }}>Read the plan</span>}
        </div>
      )}
    </button>
  );
}

function EdgeCard({ e, shapes, pickShape }: { e: Edge; shapes: Map<string, Shape>; pickShape: (id: string) => void }) {
  const verb = e.verb === 'calls' ? 'calls (request and response)' : e.verb === 'sends' ? 'sends (one-way)' : e.verb;
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
      <div className="mono">{e.verb === 'reads' ? <><b>{e.iface ?? e.from}</b> → <b>{e.to}</b></> : <><b>{e.from}</b> → <b>{e.iface ?? e.to}</b></>}</div>
      <div className="small muted">
        {e.owner} {verb}{e.via ? ` over ${e.via}` : ''} {e.status !== 'built' && <Pill kind={e.status} />} {e.change && <Pill kind="planned">{e.change}</Pill>}
        {e.modify && <> <Pill kind="building">changing: {e.modify}</Pill></>}
        {e.evidence === 'unseen' && e.status === 'built' && <> <Pill kind="unverified">not seen in code</Pill></>}
        {e.ref && <span className="mono"> · {e.ref}</span>}
      </div>
      {e.note && <div className="small">{e.note}</div>}
      {e.shapes.length === 0 && e.returns.length === 0 && <div className="small muted">No shape declared on this link yet.</div>}
      {e.shapes.map((s) => shapes.get(s) && <ShapeCard key={s} shape={shapes.get(s)!} startOpen onTrace={() => pickShape(s)} />)}
      {e.returns.length > 0 && <div className="small muted">comes back</div>}
      {e.returns.map((s) => shapes.get(s) && <ShapeCard key={s} shape={shapes.get(s)!} onTrace={() => pickShape(s)} />)}
    </div>
  );
}

function NodePanel(p: Props & { n: GNode; shapes: Map<string, Shape> }) {
  const { n, graph, ix } = p;
  const incoming = graph.edges.filter((e) => p.isInside(e.to, n.id) && !p.isInside(e.from, n.id));
  const outgoing = graph.edges.filter((e) => p.isInside(e.from, n.id) && !p.isInside(e.to, n.id));
  const onScreen = p.view?.nodes.find((v) => v.id === n.id);
  const own = n.rules.filter((r) => r.from === n.id);
  const inherited = n.rules.filter((r) => r.from !== n.id);
  return (
    <aside className="panel">
      <h2>{n.name}</h2>
      <p className="mono muted">{n.id} · {n.kind}</p>
      <p><Pill kind={n.status} /> <span className="small muted">{n.statusWhy}</span></p>
      {n.unused && <p className="unused-note">Unused: dead code kept for reference. Nothing reaches it, so it takes part in no flow. Do not build on it.</p>}
      <p>{n.description ?? n.role}</p>
      <div className="btnrow">
        {n.children.length > 0 && <button className="btn primary" onClick={() => p.toggle(n.id)}>{p.expanded.has(n.id) ? 'Collapse' : `Expand here (${n.children.length} inside)`}</button>}
        {n.children.length > 0 && <button className="btn" onClick={() => p.open(n.id)}>Open as its own view</button>}
        {onScreen?.ghost && <button className="btn" onClick={() => p.goTo(n.id)}>Go to its view</button>}
      </div>
      <DocsBlock graph={graph} ix={ix} id={n.id} openDoc={p.openDoc} />
      {(n.code.length > 0 || n.tech.length > 0 || n.image) && <h3>Code</h3>}
      {n.tech.length > 0 && <p className="small">Tech: {n.tech.map((id) => graph.tech.find((t) => t.id === id)?.name ?? id).join(', ')}{n.image ? ` · image ${n.image}` : ''}</p>}
      {n.deployment.length > 0 && (
        <>
          <h3>Runs as</h3>
          <ul className="list">
            {n.deployment.map((d) => (
              <li key={`${d.file}|${d.service}`}>
                <span className="mono">{d.service}</span> <span className="small muted">{d.env} · {d.file}</span>
                {d.image && <div className="small mono muted">{d.image}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {n.dead.length > 0 && (
        <>
          <h3>Dead code ({n.dead.length})</h3>
          <p className="small muted">No entry point reaches these files: no package script, container command, route, test or import.</p>
          <ul className="list">{n.dead.map((d) => <li key={d.path} className="mono small">{d.path} <span className="muted">({d.lines} lines)</span></li>)}</ul>
        </>
      )}
      {n.code.length > 0 && <p className="mono">{n.code.join('\n').split('\n').map((c) => <span key={c}>{c}<br /></span>)}<span className="muted">{n.files} file{n.files === 1 ? '' : 's'}</span></p>}
      {(n.coverage !== null || n.testSummary || n.tests.length > 0) && (
        <>
          <h3>Tests</h3>
          {n.tests.length > 0 && <p className="mono">{n.tests.join(', ')}</p>}
          {n.testSummary && <p className="small">Last run: {n.testSummary.passed} passed, {n.testSummary.failed} failed, {n.testSummary.skipped} skipped.</p>}
          {n.testSummary?.failures.map((f) => <p key={f} className="small" style={{ color: 'var(--red)' }}>{f}</p>)}
          {n.coverage !== null && (<><p className="small">Line coverage {n.coverage}%</p><div className="bar"><div style={{ width: `${n.coverage}%` }} /></div></>)}
          {!n.testSummary && n.coverage === null && <p className="small muted">No report read yet.</p>}
        </>
      )}
      {n.children.length > 0 && (
        <>
          <h3>Inside</h3>
          <ul className="list">
            {n.children.map((c) => {
              const k = ix.nodes.get(c)!;
              return <li key={c}><a href="#" className="mono" onClick={(e) => { e.preventDefault(); p.goTo(c); }}>{k.name}</a> <Pill kind={k.status} /><div className="small muted">{k.role}</div></li>;
            })}
          </ul>
        </>
      )}
      {n.interfaces.length > 0 && (
        <>
          <h3>{n.kind === 'store' ? 'Holds' : 'Interfaces'}</h3>
          <ul className="list">{n.interfaces.map((i) => <IfaceItem key={i.ref} i={i} shapes={p.shapes} pickShape={p.pickShape} />)}</ul>
        </>
      )}
      {incoming.length > 0 && (
        <>
          <h3>Data in ({incoming.length})</h3>
          <ul className="list">{incoming.map((e) => <li key={e.id} className="mono">{e.verb === 'reads' ? `${e.iface ?? e.from} → ${e.to}` : `${e.from} → ${e.iface ?? e.to}`}<span className="muted"> {e.shapes.join(', ')}</span></li>)}</ul>
        </>
      )}
      {outgoing.length > 0 && (
        <>
          <h3>Data out ({outgoing.length})</h3>
          <ul className="list">{outgoing.map((e) => <li key={e.id} className="mono">{e.verb === 'reads' ? `${e.iface ?? e.from} → ${e.to}` : `→ ${e.iface ?? e.to}`}<span className="muted"> {e.shapes.join(', ')}</span></li>)}</ul>
        </>
      )}
      {n.requirements.length > 0 && (
        <>
          <h3>Requirements</h3>
          <ul className="list">{n.requirements.map((q) => <ReqItem key={q.ref} q={q} />)}</ul>
        </>
      )}
      {n.rules.length > 0 && (
        <>
          <h3>Rules</h3>
          <ul className="list">
            {own.map((r, i) => <li key={`o${i}`}>{r.text}</li>)}
            {inherited.map((r, i) => <li key={`i${i}`} className="muted">{r.text} <span className="small">(from {r.from})</span></li>)}
          </ul>
        </>
      )}
      {n.todos.length > 0 && (<><h3>Todos</h3><ul className="list">{n.todos.map((t, i) => <li key={i}><Pill kind={t.kind === 'bug' ? 'failing' : t.kind === 'debt' ? 'stale' : 'unverified'}>{t.kind}</Pill> {t.text}{t.owner ? <span className="small muted"> · {t.owner}</span> : null}</li>)}</ul></>)}
      {n.prs.length > 0 && (<><h3>Open pull requests</h3><ul className="list">{n.prs.map((pr) => <li key={pr.number}><a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a> {pr.title}</li>)}</ul></>)}
      {n.codeMap && (
        <>
          <h3>Code map</h3>
          <p className="small">{n.codeMap.files} files, {n.codeMap.lines.toLocaleString()} lines, {n.codeMap.exported} exported symbols. Most central files:</p>
          {n.codeMap.top.map((f) => (
            <div className="fields" key={f.path}>
              <div className="fh" style={{ cursor: 'default' }}><span style={{ overflowWrap: 'anywhere' }}>{f.path}</span><span className="muted" style={{ fontWeight: 400 }}>{f.lines} lines</span></div>
              {f.symbols.length > 0 && (
                <table><tbody>
                  {f.symbols.map((x) => <tr key={x.name + x.line}><td>{x.name}</td><td title={x.doc}>{x.sig}</td></tr>)}
                </tbody></table>
              )}
            </div>
          ))}
          {n.codeMap.packages.length > 0 && <p className="small muted">Packages: {n.codeMap.packages.join(', ')}</p>}
          {graph.codeDeps.filter((d) => d.from === n.id || d.to === n.id).length > 0 && (
            <ul className="list small">
              {graph.codeDeps.filter((d) => d.from === n.id).map((d) => <li key={`o${d.to}`} className="mono">imports {d.to} <span className="muted">({d.count}{d.kind === 'undeclared' ? ', undeclared' : ''})</span></li>)}
              {graph.codeDeps.filter((d) => d.to === n.id).map((d) => <li key={`i${d.from}`} className="mono">imported by {d.from} <span className="muted">({d.count}{d.kind === 'undeclared' ? ', undeclared' : ''})</span></li>)}
            </ul>
          )}
        </>
      )}
      {n.runtime && (n.runtime.undeclared.length > 0 || n.runtime.unseen.length > 0 || n.runtime.confirmed > 0) && (
        <>
          <h3>Checked against the code</h3>
          <p className="small">{n.runtime.confirmed} declared link{n.runtime.confirmed === 1 ? '' : 's'} confirmed in the code.</p>
          {n.runtime.undeclared.length > 0 && (
            <ul className="list small">
              {n.runtime.undeclared.slice(0, 12).map((u, i) => <li key={i}><Pill kind="stale">in code only</Pill> <span className="mono">{u.kind} {u.what}{u.op ? ` (${u.op})` : ''}</span>{u.file && <div className="mono muted">{u.file}:{u.line}</div>}</li>)}
              {n.runtime.undeclared.length > 12 && <li className="muted">… {n.runtime.undeclared.length - 12} more. Run armature drift {n.id}.</li>}
            </ul>
          )}
          {n.runtime.unseen.length > 0 && (
            <ul className="list small">
              {n.runtime.unseen.slice(0, 8).map((u, i) => <li key={i}><Pill kind="unverified">model only</Pill> <span className="mono">{u.kind} {u.what} ({u.op})</span></li>)}
            </ul>
          )}
        </>
      )}
      {n.testedBy.length > 0 && (
        <>
          <h3>Tests that import this code ({n.testedBy.length})</h3>
          <ul className="list small">{n.testedBy.slice(0, 10).map((t) => <li key={t} className="mono">{t}</li>)}</ul>
        </>
      )}
      {(n.coChange.length > 0 || n.hot.length > 0) && (
        <>
          <h3>Change history</h3>
          {n.coChange.length > 0 && <p className="small">Usually changes together with {n.coChange.map((c, i) => <span key={c.node}>{i ? ', ' : ''}<a href="#" className="mono" onClick={(e) => { e.preventDefault(); p.goTo(c.node); }}>{c.node}</a> <span className="muted">({c.n})</span></span>)}.</p>}
          {n.hot.length > 0 && <ul className="list small">{n.hot.map((h) => <li key={h.path}><span className="mono">{h.path}</span> <span className="muted">{h.changes} changes</span></li>)}</ul>}
        </>
      )}
      <ActivityBlock n={n} />
      {n.change && <p className="small" style={{ marginTop: 12 }}>Part of change <span className="mono">{n.change}</span>.</p>}
      {n.modify && <p className="small" style={{ marginTop: 12 }}>Being altered by change <span className="mono">{n.modify}</span>.</p>}
      {n.never.length > 0 && <p className="small" style={{ marginTop: 12 }}>Must never touch: {n.never.map((b) => <span key={b.node} className="mono" title={b.why ?? ''}>{b.node} </span>)}</p>}
      <p className="mono muted" style={{ marginTop: 12 }}>{n.source}</p>
      <AskAgent subject={`node \`${n.id}\``} file={n.source} />
    </aside>
  );
}

/** One group of checks, split by code: what the code means, how many, and each finding. */
function ProblemGroup({ title, tone, list, open }: { title: string; tone: 'error' | 'wrong' | 'incomplete'; list: Problem[]; open?: boolean }) {
  if (list.length === 0) return null;
  const byCode = new Map<string, Problem[]>();
  for (const x of list) byCode.set(x.code, [...(byCode.get(x.code) ?? []), x]);
  const codes = [...byCode].sort((a, b) => b[1].length - a[1].length);
  return (
    <section className={`pgroup ${tone}`}>
      <h3><i className="pdot" />{title} <span className="pcount">{list.length}</span></h3>
      {codes.map(([code, items]) => (
        <details key={code} className="pcode" open={open && codes.length <= 3}>
          <summary>
            <span className="mono">{code}</span> <span className="pcount">{items.length}</span>
            {WARNING_INFO[code] && <div className="small muted">{WARNING_INFO[code].what}</div>}
          </summary>
          {items.map((x, i) => (
            <div className="prob" key={i}>
              {x.message}
              {x.file && <div className="mono muted">{x.file}</div>}
            </div>
          ))}
        </details>
      ))}
    </section>
  );
}

/** How much of the repo the model places, with the biggest gaps. */
function CoverageBlock({ c, dead }: { c: Coverage; dead: number }) {
  const placed = c.owned + c.tech + (c.docs ?? 0) + c.builtin + c.ignored;
  const pct = Math.floor((placed / c.files) * 1000) / 10;
  const gaps = c.byDir.filter((d) => d.unowned > 0).slice(0, 6);
  return (
    <section className="pgroup">
      <h3><i className="pdot" />Coverage <span className="pcount">{pct}%</span></h3>
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <p className="small">{c.owned} files in nodes · {c.tech} tool files · {c.docs ?? 0} documents · {c.ignored} ignored · {c.builtin} lockfiles and generated · <b>{c.unowned} unplaced</b> of {c.files}. {dead} dead code file{dead === 1 ? '' : 's'}.</p>
      {gaps.length > 0 && <ul className="list">{gaps.map((d) => <li key={d.dir} className="small"><span className="mono">{d.dir}/</span> <span className="muted">{d.unowned} of {d.files} unplaced</span></li>)}</ul>}
    </section>
  );
}
