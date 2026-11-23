// The "To approve" lens: every change that waits for a person, with what approving it covers and
// the button that approves it. Approving is the one thing the viewer writes, and only on a click here.
import { useState } from 'react';
import { awaitingApproval, type Change, type Graph } from '../../src/types.ts';

export type ApproveFn = (id: string) => Promise<{ ok: boolean; message: string }>;

export const WAIT_LABEL = {
  proposed: 'needs approval',
  'scope-changed': 'changed since approval',
  unrecorded: 'approval not recorded',
} as const;

const WAIT_WHY = {
  proposed: 'Nobody has approved this plan yet. No code is written for it until a person does.',
  'scope-changed': 'Elements joined or left this change after it was approved. The approval covers only what it held then.',
  unrecorded: 'This change is marked approved, but nothing records who approved which elements.',
} as const;

/** The changes that wait for a person, in the order the model gives them. */
export function pendingChanges(graph: Graph): Change[] {
  return graph.changes.filter((c) => awaitingApproval(c) !== null);
}

const SHOWN = 8;

/** A date as a person reads it, with how long ago it was: "21 Nov 2026 · 2 days ago". Empty when the text is no date. */
export function dated(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const day = new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const days = Math.floor((now - t) / 86_400_000);
  const ago = days < 1 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : days < 730 ? `${Math.round(days / 30.4)} months ago` : `${Math.round(days / 365)} years ago`;
  return `${day} · ${ago}`;
}

function ReviewCard({ c, on, pick, onRead, approve, onDone, broken }: { c: Change; on: boolean; pick: () => void; onRead?: () => void; approve: ApproveFn | null; onDone: (text: string) => void; broken: number }) {
  const wait = awaitingApproval(c) ?? 'proposed';
  const [all, setAll] = useState(false);
  const [stage, setStage] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const added = new Set(c.approval?.added ?? []);
  const removed = c.approval?.removed ?? [];
  const elements = all ? c.elements : c.elements.slice(0, SHOWN);
  const secErrors = c.security?.errors ?? [];
  const blocked = c.elements.length === 0
    ? 'Nothing is tagged with this change yet, so there is nothing to approve.'
    : secErrors.length
      ? 'It has security errors. They are fixed in the model first.'
      : broken
        ? `The model has ${broken} error${broken === 1 ? '' : 's'}. They are fixed first (open the checks).`
        : null;
  const command = `armature approve ${c.id}`;
  const proposed = dated(c.proposedAt);
  const approved = dated(c.approval?.at);

  const run = (): void => {
    if (!approve) return;
    setStage('busy');
    setFailed(null);
    approve(c.id).then(
      (r) => {
        if (r.ok) onDone(`Approved: ${c.title}`);
        else setFailed(r.message);
        setStage('idle');
      },
      (e) => {
        setFailed(String(e));
        setStage('idle');
      },
    );
  };

  return (
    <section className={`review${on ? ' on' : ''}`} aria-label={`${c.title}: ${WAIT_LABEL[wait]}`}>
      <div className="t">{c.title}</div>
      <div className="s"><span className="pill need">{WAIT_LABEL[wait]}</span> <span className="mono">{c.id}</span></div>
      {(proposed || approved) && (
        <p className="small when">
          {proposed && <span>Proposed <time dateTime={c.proposedAt}>{proposed}</time></span>}
          {approved && <span>Approved <time dateTime={c.approval?.at}>{approved}</time>{c.approval?.by ? ` by ${c.approval.by}` : ''}</span>}
        </p>
      )}
      <p className="small muted">{WAIT_WHY[wait]}</p>
      {c.why && <p className="small">{c.why}</p>}
      {c.doneWhen.length > 0 && <p className="small">Done when: {c.doneWhen.join(' ')}</p>}
      {c.waits.length > 0 && <p className="small muted">Comes after {c.waits.join(', ')}, not done yet.</p>}

      <h3>What approving covers ({c.elements.length})</h3>
      {c.elements.length === 0 ? <p className="small muted">No elements yet.</p> : (
        <ul className="els">
          {elements.map((e) => <li key={e} className={added.has(e) ? 'added' : ''}>{e}{added.has(e) && <span className="muted"> · new since approval</span>}</li>)}
          {removed.map((e) => <li key={`-${e}`} className="removed"><s>{e}</s><span className="muted"> · removed since approval</span></li>)}
        </ul>
      )}
      {c.elements.length > SHOWN && <button className="linkish small" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${c.elements.length}`}</button>}

      {c.security && (
        <>
          <h3>Security</h3>
          {secErrors.length > 0 && <div className="notice err">{secErrors.map((e) => <div key={e}>{e}</div>)}</div>}
          {c.security.lines.length > 0
            ? <pre className="sec">{c.security.lines.join('\n')}</pre>
            : secErrors.length === 0 && <p className="small muted">No new entry point, no sensitive data sent out, no secret.</p>}
        </>
      )}

      {failed && <div className="notice err" role="alert" style={{ marginTop: 10 }}>{failed}</div>}
      {blocked && <p className="small muted" style={{ marginTop: 10 }}>Cannot be approved yet. {blocked}</p>}
      <div className="btnrow">
        {approve && stage !== 'confirm' && <button className="btn primary" disabled={!!blocked || stage === 'busy'} onClick={() => setStage('confirm')}>{stage === 'busy' ? 'Approving…' : 'Approve'}</button>}
        {approve && stage === 'confirm' && (
          <>
            <button className="btn primary" autoFocus onClick={run}>Yes, approve {c.elements.length} element{c.elements.length === 1 ? '' : 's'}</button>
            <button className="btn" onClick={() => setStage('idle')}>Cancel</button>
          </>
        )}
        {stage !== 'confirm' && onRead && <button className="btn" onClick={onRead}>Read the plan</button>}
        {stage !== 'confirm' && <button className="btn" aria-pressed={on} onClick={pick}>{on ? 'Shown on the map' : 'Show on the map'}</button>}
      </div>
      {!approve && (
        <p className="small muted" style={{ marginTop: 8 }}>
          This page is a saved copy, so it cannot approve. Run <span className="mono">{command}</span>{' '}
          <button className="linkish" onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); }}>{copied ? 'copied' : 'copy'}</button>
        </p>
      )}
    </section>
  );
}

export function ReviewPanel({ graph, changeId, setChange, openDoc, approve }: { graph: Graph; changeId: string | null; setChange: (id: string | null) => void; openDoc: (p: string) => void; approve: ApproveFn | null }) {
  const [done, setDone] = useState<string[]>([]);
  const pending = pendingChanges(graph);
  const broken = graph.problems.filter((x) => x.level === 'error').length;
  return (
    <aside className="panel">
      <h2>To approve</h2>
      <p className="muted small">Plans that wait for a person. Read what each one covers, then approve it; approving records who approved which elements, and code is written only after that.</p>
      {done.map((d) => <div key={d} className="notice" role="status">{d}</div>)}
      {pending.length === 0 && <p style={{ marginTop: 12 }}>Nothing waits for approval.</p>}
      {pending.map((c) => (
        <ReviewCard
          key={c.id}
          c={c}
          on={c.id === changeId}
          pick={() => setChange(c.id === changeId ? null : c.id)}
          onRead={c.doc && graph.docs.some((d) => d.path === c.doc) ? () => openDoc(c.doc as string) : undefined}
          approve={approve}
          onDone={(text) => setDone((d) => [...d.filter((x) => x !== text), text])}
          broken={broken}
        />
      ))}
    </aside>
  );
}
