import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { readDoc } from '../src/docs.js';
import { docsText, impact, orient } from '../src/render.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-docs-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\n');
  write('armature/nodes/api.yaml', 'kind: service\nrole: order API\ncode: [apps/api/**]\ndocs: [docs/api-guide.md]\n');
  write('armature/nodes/billing.yaml', 'kind: worker\nrole: charges cards\ncode: [apps/billing/**]\naccepts:\n  - id: refund\n    via: http\n    change: refunds\n');
  write('armature/changes/refunds.yaml', 'title: Refunds\nstate: approved\ndoc: docs/refunds-plan.md\n');
  write('apps/api/src/server.ts', 'export const x = 1;\n');
  write('apps/api/README.md', '# Order API\n\nThe API takes orders from the web shop and stores them.\n');
  write('apps/billing/src/charge.ts', 'export const y = 1;\n');
  write('docs/api-guide.md', '# API guide\n\nHow to call the order API from a client.\n');
  write('docs/refunds-plan.md', '# Refunds\n\nDate: 2026-11-01. Status: not started.\n\nRefunds go back through the card provider, see `apps/billing/src/charge.ts` and apps/billing/src/refund.ts.\n\n## Design\n\n## Rollout\n');
  write('docs/notes.md', '# Notes\n\nNothing about any node in particular, just enough words here.\n');
  write('node_modules/x/README.md', '# vendored\n');
  return root;
}

describe('document library', () => {
  it('reads titles, status and outline, and links documents to nodes three ways', () => {
    const root = repo();
    const g = compile(root);
    expect(g.docs.map((d) => d.path)).toEqual(['apps/api/README.md', 'docs/api-guide.md', 'docs/notes.md', 'docs/refunds-plan.md']);
    const plan = g.docs.find((d) => d.path === 'docs/refunds-plan.md')!;
    expect(plan).toMatchObject({ title: 'Refunds', status: 'not started.', outline: ['Design', 'Rollout'], changes: ['refunds'] });
    expect(plan.links).toEqual([{ node: 'billing', how: 'declared', count: 3 }]);
    const api = g.nodes.find((n) => n.id === 'api')!;
    expect(api.docs.map((d) => `${d.path}:${d.how}`)).toEqual(['docs/api-guide.md:declared', 'apps/api/README.md:inside']);
    expect(g.docs.find((d) => d.path === 'docs/notes.md')!.links).toEqual([]);
    expect(g.docs.find((d) => d.path === 'apps/api/README.md')!.summary).toBe('The API takes orders from the web shop and stores them.');
  });

  it('warns about a declared document that does not exist', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'armature/nodes/api.yaml'), 'kind: service\nrole: order API\ncode: [apps/api/**]\ndocs: [docs/missing.md]\n');
    expect(compile(root).problems.some((p) => p.message.includes('docs/missing.md'))).toBe(true);
  });

  it('serves only Markdown inside the repo', () => {
    const root = repo();
    expect(readDoc(root, 'docs/notes.md')).toContain('# Notes');
    expect(readDoc(root, '../etc/passwd.md')).toBeNull();
    expect(readDoc(root, 'apps/api/src/server.ts')).toBeNull();
    expect(readDoc(root, 'node_modules/x/README.md')).toBeNull();
    // Markdown kept as test data is not a document.
    expect(readDoc(root, 'packages/invoices/test/fixtures/sample.md')).toBeNull();
  });

  it('lists plans and documents for an agent', () => {
    const text = docsText(compile(repo()), 'billing');
    expect(text).toContain('refunds [approved] Refunds  -> docs/refunds-plan.md');
    // A plan's status is computed from its change, not read from the line typed in the document.
    expect(text).toContain('docs/refunds-plan.md: Refunds (approved) [named in the model]');
  });
});

/** The same repo with documents that belong to the model: a header, and [[references]] in the text. */
function modelRepo(): string {
  const root = repo();
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('armature/shapes/orders.yaml', 'Order:\n  fields:\n    id: uuid\n    total: money\n');
  write('armature/changes/receipts.yaml', 'title: Receipts\nstate: proposed\n');
  write('armature/nodes/mailer.yaml', 'kind: worker\nrole: sends receipts\ncode: [apps/mailer/**]\nchange: receipts\n');
  write(
    'armature/docs/plans/receipts.md',
    '---\nkind: plan\nchange: receipts\nabout: [billing#refund]\n---\n# Receipts\n\nThe [[mailer]] reads an [[Order]] from [[api|the order API]] and mails [[Order.total]].\n\nIt never calls [[ledger]]. In code, `[[not-a-ref]]` and [[ -f x ]] are left alone.\n',
  );
  write('armature/docs/decisions/no-queue.md', '---\nkind: decision\nabout: api\n---\n# No queue between the API and billing\n\nA direct call is enough at this volume, and one fewer thing to run.\n');
  write('armature/docs/untyped.md', '# A document with no header\n\nIt lives in the home of model documents, so it needs a kind.\n');
  return root;
}

describe('documents in the model', () => {
  it('reads the header and resolves references like the rest of the model', () => {
    const g = compile(modelRepo());
    const plan = g.docs.find((d) => d.path === 'armature/docs/plans/receipts.md')!;
    expect(plan).toMatchObject({ kind: 'plan', model: true, loose: false, changes: ['receipts'], state: 'proposed, 0 of 1 built', broken: ['ledger'] });
    expect(plan.refs.map((r) => `${r.type} ${r.id}`).sort()).toEqual(['interface billing#refund', 'node api', 'node mailer', 'shape Order']);
    expect(plan.refs.find((r) => r.id === 'Order')!.count).toBe(2);
    expect(plan.links.map((l) => `${l.node}:${l.how}`).sort()).toEqual(['api:declared', 'billing:declared', 'mailer:declared']);
    expect(plan.summary).toBe('The mailer reads an Order from the order API and mails Order.total.');
    // The change finds its plan from the document's header.
    expect(g.changes.find((c) => c.id === 'receipts')).toMatchObject({ doc: 'armature/docs/plans/receipts.md', docs: ['armature/docs/plans/receipts.md'] });
    expect(g.nodes.find((n) => n.id === 'api')!.docs.map((d) => d.path)).toContain('armature/docs/decisions/no-queue.md');
  });

  it('warns about broken references, missing kinds, typed status and loose documents', () => {
    const g = compile(modelRepo());
    const of = (code: string): string[] => g.problems.filter((p) => p.code === code).map((p) => p.message);
    expect(of('doc-reference')).toEqual(['"armature/docs/plans/receipts.md" names [[ledger]], which is not in the model.']);
    expect(of('doc-header')).toEqual(['"armature/docs/untyped.md" has no kind in its header. Add "kind:" with one of plan, decision, guide, runbook, review, research, note.']);
    expect(of('typed-status')[0]).toContain('docs/refunds-plan.md');
    // docs/notes.md has no header and nothing names it; the API guide and the READMEs are placed.
    expect(of('loose-doc')).toEqual(['1 document under "docs" is not tied to the model. Give each a header (kind, about), or list it under a node\'s "docs:".']);
    expect(g.docs.filter((d) => d.loose).map((d) => d.path)).toEqual(['docs/notes.md']);
    expect(g.problems.filter((p) => p.level === 'error')).toEqual([]);
  });

  it('answers which documents name a part of the model', () => {
    const g = compile(modelRepo());
    expect(impact(g, 'Order')).toContain('armature/docs/plans/receipts.md (plan): Receipts');
    expect(impact(g, 'billing#refund')).toContain('armature/docs/plans/receipts.md (plan): Receipts');
    expect(docsText(g, 'Order')).toContain('armature/docs/plans/receipts.md: Receipts (plan) (proposed, 0 of 1 built)');
    expect(docsText(g, 'receipts')).toContain('change receipts [proposed] Receipts');
    expect(docsText(g, undefined, { loose: true })).toContain('docs/notes.md: Notes');
    expect(docsText(g, 'nothing-like-this')).toBe('Nothing named "nothing-like-this".');
  });

  it('uses the documents folder that system.yaml names', () => {
    const root = modelRepo();
    fs.appendFileSync(path.join(root, 'armature/system.yaml'), 'docs: docs/\n');
    const g = compile(root);
    expect(g.system.docs).toBe('docs');
    // Every Markdown file in docs/ now needs a kind; armature/docs/ is no longer special.
    const headers = g.problems.filter((p) => p.code === 'doc-header').map((p) => p.file).sort();
    expect(headers).toEqual(['docs/api-guide.md', 'docs/notes.md', 'docs/refunds-plan.md']);
    expect(g.docs.find((d) => d.path === 'docs/notes.md')).toMatchObject({ model: true, loose: false });
    expect(g.docs.find((d) => d.path === 'armature/docs/untyped.md')).toMatchObject({ model: false });
    expect(orient(g)).toContain('its plan in docs/<id>-plan.md');
    expect(orient(g)).toContain('New ones go under docs/.');
  });

  it('refuses a documents folder outside the repo, and warns about one that is missing', () => {
    const root = modelRepo();
    fs.appendFileSync(path.join(root, 'armature/system.yaml'), 'docs: ../elsewhere\n');
    expect(compile(root).problems.some((p) => p.level === 'error' && p.message.includes('not a folder inside the repo'))).toBe(true);
    const other = modelRepo();
    fs.appendFileSync(path.join(other, 'armature/system.yaml'), 'docs: handbook\n');
    expect(compile(other).problems.some((p) => p.code === 'reference' && p.message.includes('"handbook"'))).toBe(true);
  });

  it('serves documents under armature/docs and still nothing from the cache', () => {
    const root = modelRepo();
    expect(readDoc(root, 'armature/docs/plans/receipts.md')).toContain('kind: plan');
    expect(readDoc(root, 'armature/.cache/x.md')).toBeNull();
  });
});
