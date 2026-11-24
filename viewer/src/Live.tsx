// What agent sessions are doing right now, over the map: one card per session, with the part it is
// in, the task it was given, the change it works on and the parts it has touched.
import { useEffect, useRef, useState } from 'react';
import type { Graph, Live, LiveFile, LiveSession, LiveStep } from '../../src/types.ts';
import { fileId, visibleFor, type Index } from './view.ts';

export type LiveMark = 'now' | 'touched';

/** Where a file shows on the map: its own block when the map has one, else the node that owns it. */
const spotOf = (ix: Index, node: string, path?: string): string => (path && ix.nodes.has(fileId(node, path)) ? fileId(node, path) : node);

/** Which blocks on the map carry a mark: the one a working session is in, and the ones a session edited. */
export function liveMarks(live: Live | null, ix: Index, focus: string | null, expanded: Set<string>): Map<string, LiveMark> {
  const marks = new Map<string, LiveMark>();
  for (const s of live?.sessions ?? []) {
    for (const n of s.nodes) {
      for (const f of n.files) {
        if (!f.edits) continue;
        const at = visibleFor(ix, spotOf(ix, n.id, f.path), focus, expanded);
        if (at && !marks.has(at)) marks.set(at, 'touched');
      }
    }
  }
  const now = liveNode(live, ix);
  const at = now ? visibleFor(ix, now, focus, expanded) : null;
  if (at) marks.set(at, 'now');
  return marks;
}

/** The files sessions edited, by the block on the map that shows them: the file itself, its node, or the closed group around it. */
export function liveFiles(live: Live | null, ix: Index, focus: string | null, expanded: Set<string>): Map<string, LiveFile[]> {
  const out = new Map<string, LiveFile[]>();
  for (const s of live?.sessions ?? []) {
    for (const n of s.nodes) {
      for (const f of n.files) {
        if (!f.edits) continue;
        const at = visibleFor(ix, spotOf(ix, n.id, f.path), focus, expanded);
        if (!at) continue;
        const list = out.get(at) ?? [];
        const had = list.find((x) => x.path === f.path);
        if (had) had.edits += f.edits;
        else list.push({ ...f });
        out.set(at, list);
      }
    }
  }
  return out;
}

/** Every place a session edited: the block of each edited file, or its node. The session view opens the groups around them. */
export function editedSpots(live: Live | null, ix: Index): string[] {
  return [...new Set((live?.sessions ?? []).flatMap((s) => s.nodes.flatMap((n) => n.files.filter((f) => f.edits > 0).map((f) => spotOf(ix, n.id, f.path)))))];
}

/** The paths of every file a session edited. */
export function editedPaths(live: Live | null): string[] {
  return [...new Set((live?.sessions ?? []).flatMap((s) => s.nodes.flatMap((n) => n.files.filter((f) => f.edits > 0).map((f) => f.path))))].sort();
}

/** "+12 −3" for a file, or "new, 40 lines". Empty when git was not asked or says nothing. */
export function sizeOf(f: LiveFile): string {
  if (f.added === undefined) return '';
  if (f.fresh) return `new, ${f.added} line${f.added === 1 ? '' : 's'}`;
  return `+${f.added} −${f.removed ?? 0}`;
}

/** Where the busiest working session is: the block of the file it is in, or its part. */
export function liveNode(live: Live | null, ix?: Index): string | null {
  const s = live?.sessions.find((x) => x.working && x.part);
  if (!s?.part) return null;
  return ix && s.now?.node === s.part ? spotOf(ix, s.part, s.now.file) : s.part;
}

function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

function headline(s: LiveSession, ix: Index): string {
  if (!s.working) return `Agent stopped ${ago(s.lastAt)}`;
  const step = s.now;
  if (!step) return 'Agent is working';
  if (step.kind === 'run') return `Agent is running ${step.text || 'a command'}`;
  const where = step.node ? ix.nodes.get(step.node)?.name ?? step.node : step.file?.split('/').pop() ?? 'a file';
  return `Agent is ${step.kind === 'read' ? 'reading' : 'editing'} ${where}`;
}

export function LiveBar({ live, graph, ix, follow, setFollow, goTo, openChange, openDiff }: {
  live: Live;
  graph: Graph;
  ix: Index;
  follow: boolean;
  setFollow: (on: boolean) => void;
  goTo: (id: string) => void;
  openChange: (id: string) => void;
  openDiff: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const shown = live.sessions.slice(0, 3);
  if (!shown.length) return null;
  return (
    <aside className="livebar" aria-label="Agent sessions">
      {shown.map((s) => {
        const changes = s.changes.map((id) => graph.changes.find((c) => c.id === id)).filter((c) => !!c);
        return (
          <section key={s.id} className={s.working ? 'live on' : 'live'}>
            <button className="live-head" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide the details' : 'Show the details'}>
              <span className="live-dot" />
              <span className="live-what" role="status">{headline(s, ix)}</span>
            </button>
            {open && (
              <div className="live-body">
                {s.working && s.now?.file && <div className="live-file">{s.now.file}</div>}
                {s.prompt && <div className="live-prompt">“{s.prompt}”</div>}
                {changes.map((c) => (
                  <button key={c.id} className="live-change" onClick={() => openChange(c.id)}>
                    <span>{c.title}</span>
                    <span className="live-count">{c.progress.built} of {c.progress.total} built</span>
                  </button>
                ))}
                {s.nodes.length > 0 && (
                  <div className="live-nodes">
                    {s.nodes.slice(0, 8).map((n) => (
                      <button key={n.id} className="chip" onClick={() => goTo(n.id)} title={`${n.edits} edit${n.edits === 1 ? '' : 's'}, ${n.reads} read${n.reads === 1 ? '' : 's'}\n${n.files.map((f) => f.path).join('\n')}`}>
                        {ix.nodes.get(n.id)?.name ?? n.id}
                        {n.edits > 0 && <b>{n.edits}</b>}
                      </button>
                    ))}
                    {s.nodes.length > 8 && <span className="live-more">and {s.nodes.length - 8} more</span>}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
      {open && (
        <label className="live-follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Keep the working part in view
        </label>
      )}
      {open && <a className="live-follow" href="?view=session" title="A view made for a narrow pane: the map follows the agent, with its steps underneath">Open the session view</a>}
    </aside>
  );
}

/** The steps of a session as lines to read, newest first. A write is one line, and a step repeated in a row is counted. */
export function stepLines(steps: LiveStep[], ix: Index): Array<{ at: string; verb: string; what: string; node?: string; times: number }> {
  const out: Array<{ at: string; verb: string; what: string; node?: string; times: number }> = [];
  for (const st of steps) {
    // "editing" is the write about to happen; "edited" is the line for it.
    if (st.kind === 'editing' || st.kind === 'start') continue;
    const verb = st.kind === 'read' ? 'Read' : st.kind === 'edited' ? 'Edited' : st.kind === 'run' ? 'Ran' : st.kind === 'prompt' ? 'Task' : 'Stopped';
    const what = st.kind === 'run' ? st.text || 'a command' : st.kind === 'prompt' ? st.text ?? '' : st.file ?? '';
    const last = out[out.length - 1];
    if (last && last.verb === verb && last.what === what) last.times++;
    else out.push({ at: st.at, verb, what, node: st.node && ix.nodes.has(st.node) ? st.node : undefined, times: 1 });
  }
  return out;
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The session view's top line: what the agent is doing, in one row that fits a narrow pane. */
export function SessionTop({ system, session, sessions, pick, ix }: { system: string; session: LiveSession | null; sessions: LiveSession[]; pick: (id: string) => void; ix: Index }) {
  return (
    <header className="stop">
      <div className={session?.working ? 'stop-now on' : 'stop-now'}>
        <span className="live-dot" />
        <span className="stop-what" role="status">{session ? headline(session, ix) : 'No agent session in this repo yet'}</span>
        <a className="chip" href={window.location.pathname} title={`The whole viewer of ${system}`}>Full viewer</a>
      </div>
      {session?.working && session.now?.file && <div className="live-file">{session.now.file}</div>}
      {sessions.length > 1 && (
        <div className="stop-pick" role="tablist" aria-label="Sessions">
          {sessions.map((s, i) => (
            <button key={s.id} role="tab" aria-selected={s.id === session?.id} className={s.id === session?.id ? 'chip on' : 'chip'} onClick={() => pick(s.id)}>
              Session {i + 1}{s.working ? '' : ' (stopped)'}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}

/** Under the map: the task and the parts touched, then the steps. The files are on the map itself, inside their parts. */
export function SessionSheet({ session, graph, ix, goTo, openDiff }: { session: LiveSession | null; graph: Graph; ix: Index; goTo: (id: string) => void; openDiff: (path: string) => void }) {
  // The newest step is the first line: when one arrives, the list goes back to the top to show it.
  const list = useRef<HTMLOListElement>(null);
  const [stepsShown, setStepsShown] = useState(true);
  const newest = session?.steps[0]?.at;
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [newest, session?.id]);
  if (!session) {
    return <footer className="ssheet"><p className="ssheet-none">Steps appear here once a Claude Code session with the Armature hooks works in this repo.</p></footer>;
  }
  const changes = session.changes.map((id) => graph.changes.find((c) => c.id === id)).filter((c) => !!c);
  const lines = stepLines(session.steps, ix);
  return (
    <footer className="ssheet">
      <div className="ssheet-top">
        {session.prompt && <p className="ssheet-task">“{session.prompt}”</p>}
        {changes.map((c) => (
          <div key={c.id} className="ssheet-change">
            <div><b>{c.title}</b><span className="live-count">{c.progress.built} of {c.progress.total} built{c.progress.reqTotal ? ` · ${c.progress.reqVerified} of ${c.progress.reqTotal} verified` : ''}</span></div>
            <div className="bar"><div style={{ width: `${c.progress.total ? (100 * c.progress.built) / c.progress.total : 0}%` }} /></div>
          </div>
        ))}
        {session.nodes.length > 0 && (
          <div className="live-nodes">
            {session.nodes.map((n) => (
              <button key={n.id} className={n.edits ? 'chip worked' : 'chip'} onClick={() => goTo(n.id)} title={`${n.edits} edit${n.edits === 1 ? '' : 's'}, ${n.reads} read${n.reads === 1 ? '' : 's'}\n${n.files.map((f) => f.path).join('\n')}`}>
                {ix.nodes.get(n.id)?.name ?? n.id}
                {n.edits > 0 && <b>{n.edits}</b>}
              </button>
            ))}
          </div>
        )}
      </div>
      <section className={stepsShown ? 'steps-sec open' : 'steps-sec'}>
        <button className="sec-head" onClick={() => setStepsShown(!stepsShown)} aria-expanded={stepsShown}>
          <span className={stepsShown ? 'tree-chev open' : 'tree-chev'} aria-hidden="true">›</span>
          <span className="sec-title">Steps</span>
          <span className="sec-count">{lines.length}</span>
        </button>
        {stepsShown && (
          <ol className="ssheet-steps" ref={list}>
            {lines.map((l, i) => (
              <li key={i} className={i === 0 && session.working ? 'on' : ''}>
                <time dateTime={l.at}>{clock(l.at)}</time>
                <span className="ssheet-verb">{l.verb}</span>
                {l.verb === 'Edited'
                  ? <button className="ssheet-what link" onClick={() => openDiff(l.what)} title="Show what changed in this file">{l.what}{l.times > 1 ? ` ×${l.times}` : ''}</button>
                  : <span className="ssheet-what">{l.what}{l.times > 1 ? ` ×${l.times}` : ''}</span>}
                {l.node && <button className="ssheet-part" onClick={() => goTo(l.node!)}>{ix.nodes.get(l.node)?.name}</button>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </footer>
  );
}

/** What one edited file holds that the last commit does not, over the map. Asked for again as the file changes. */
export function DiffView({ path, file, onClose }: { path: string; file: LiveFile | null; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const stamp = `${file?.edits ?? 0}|${file?.added ?? 0}|${file?.removed ?? 0}`;
  useEffect(() => {
    let live = true;
    fetch(`/diff?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (live) { setText(t); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [path, stamp]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // The file header git prints says what the title already says.
  const lines = (text ?? '').split('\n').filter((l) => !/^(diff --git |index |--- |\+\+\+ |new file mode|old mode|new mode)/.test(l));
  if (lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, 2000);
  return (
    <section className="diffview" aria-label={`Changes in ${path}`}>
      <header className="diff-head">
        <div className="diff-title">
          <b>{path.split('/').pop()}</b>
          <span>{path}</span>
        </div>
        {file && <span className="tree-size">{file.added !== undefined && !file.fresh ? <><b className="plus">+{file.added}</b> <b className="minus">−{file.removed ?? 0}</b></> : sizeOf(file)}</span>}
        <button className="chip" onClick={onClose}>Close ✕</button>
      </header>
      <div className="diff-body">
        {failed && <p className="diff-note">This file is not one a session shown here edited.</p>}
        {!failed && text === null && <p className="diff-note">Loading…</p>}
        {!failed && text !== null && shown.length === 0 && <p className="diff-note">Nothing differs from the last commit: the edit was committed, or undone.</p>}
        {shown.map((l, i) => (
          <div key={i} className={l.startsWith('@@') ? 'dl hunk' : l.startsWith('+') ? 'dl add' : l.startsWith('-') ? 'dl del' : 'dl'}>{l || ' '}</div>
        ))}
        {lines.length > shown.length && <p className="diff-note">{lines.length - shown.length} more lines are not shown.</p>}
      </div>
    </section>
  );
}
