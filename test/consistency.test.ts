// The same fact is written in several places: the CLI, its help text, the spec, the skill, the
// schema, the plugin build. This keeps them from drifting apart.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WRITE_TOOLS } from '../src/agent.js';
import { PALETTES, STYLE_TOKENS } from '../src/style.js';
import { DOC_KINDS, NODE_KINDS, VIA_KINDS, WARNING_INFO } from '../src/types.js';
// @ts-expect-error a plain .mjs script with no types
import { pluginInputsHash } from '../scripts/plugin-inputs.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const sources = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.ts')).map((f) => read(`src/${f}`)).join('\n');

describe('one fact, one home', () => {
  it('documents every command the CLI runs, in its help and in the spec', () => {
    const cli = read('src/cli.ts');
    const commands = [...cli.matchAll(/^\s+case '([a-z][a-z-]*)':/gm)].map((m) => m[1]).filter((c) => !['help', 'hook', 'build'].includes(c));
    expect(commands.length).toBeGreaterThan(30);
    const help = cli.slice(cli.indexOf('const HELP'), cli.indexOf('function parse'));
    const spec = read('SPEC.md');
    for (const c of commands) {
      expect(help, `"armature ${c}" is missing from the help text`).toMatch(new RegExp(`armature ${c}\\b`));
      expect(spec, `"armature ${c}" is missing from SPEC.md`).toMatch(new RegExp(`armature ${c}\\b`));
    }
  });

  it('explains every warning code the compiler can raise', () => {
    const raised = new Set([...sources.matchAll(/\bwarn\('([a-z-]+)'/g)].map((m) => m[1]));
    for (const m of sources.matchAll(/code: '([a-z-]+)',\s*\n?\s*file/g)) raised.add(m[1]);
    for (const code of raised) expect(WARNING_INFO[code], `no entry in WARNING_INFO for "${code}"`).toBeTruthy();
    const spec = read('SPEC.md');
    for (const code of Object.keys(WARNING_INFO)) expect(spec, `SPEC.md does not mention the warning "${code}"`).toContain(`\`${code}\``);
  });

  it('lists the same node kinds, document kinds and transports everywhere', () => {
    const schema = JSON.parse(read('schemas/armature.schema.json')).$defs;
    expect([...schema.kind.enum].sort()).toEqual([...NODE_KINDS].sort());
    expect([...schema.document.properties.kind.enum].sort()).toEqual([...DOC_KINDS].sort());
    const spec = read('SPEC.md');
    const skill = read('skills/armature-language/SKILL.md');
    for (const k of NODE_KINDS) {
      expect(spec, `SPEC.md does not list the node kind "${k}"`).toContain(`\`${k}\``);
      expect(skill).toMatch(new RegExp(`\\b${k}\\b`));
    }
    for (const v of VIA_KINDS) {
      expect(spec, `SPEC.md does not list the transport "${v}"`).toContain(`\`${v}\``);
      expect(skill, `the language skill does not list the transport "${v}"`).toMatch(new RegExp(`\\b${v}\\b`));
    }
  });

  it('allows in the schema every key the compiler reads from a node, a link and a change', () => {
    const schema = JSON.parse(read('schemas/armature.schema.json')).$defs;
    for (const key of ['modify', 'never', 'change', 'retire', 'entry', 'deploy', 'docs', 'scopes']) expect(Object.keys(schema.node.properties)).toContain(key);
    for (const key of ['id', 'modify', 'change', 'retire', 'shape', 'takes', 'gives', 'via', 'note']) expect(Object.keys(schema.link.oneOf[1].properties)).toContain(key);
    for (const key of ['after', 'state', 'doc', 'done_when']) expect(Object.keys(schema.change.properties)).toContain(key);
    for (const key of ['accept', 'ignore', 'gate', 'docs', 'reports']) expect(Object.keys(schema.system.properties)).toContain(key);
    for (const key of ['covers', 'modify', 'tests', 'match']) expect(Object.keys(schema.requirement.properties)).toContain(key);
  });

  it('ships a plugin built from the current source', () => {
    expect(read('plugin/source.sha256').trim(), 'plugin/ is older than the source. Run "npm run build:plugin" and commit plugin/.').toBe(pluginInputsHash(root));
  });

  it('gives the plugin the same hooks a local install writes', () => {
    const build = read('scripts/build-plugin.mjs');
    expect(build).toContain(`const WRITE_TOOLS = '${WRITE_TOOLS}';`);
    for (const name of ['session-start', 'prompt', 'pre-write', 'pre-bash', 'pre-plan', 'post-edit', 'stop']) {
      expect(build, `the plugin build does not register the hook "${name}"`).toContain(`hook('${name}')`);
      expect(read('src/agent.ts')).toContain(`cmd('${name}')`);
      expect(read('src/agent.ts')).toContain(`name === '${name}'`);
    }
  });

  it('does not list as missing what the spec describes as built', () => {
    const spec = read('SPEC.md');
    const notYet = spec.slice(spec.indexOf('## 11.'), spec.indexOf('## 12.'));
    expect(notYet).not.toMatch(/field extraction from Zod/i);
    expect(notYet).not.toMatch(/Call-site/i);
  });

  it('names the same style colours and palettes in the schema, the spec and the code', () => {
    const schema = JSON.parse(read('schemas/armature.schema.json')).$defs;
    expect(Object.keys(schema.colors.properties).sort()).toEqual(Object.keys(STYLE_TOKENS).sort());
    expect([...schema.system.properties.style.properties.palette.enum].sort()).toEqual(Object.keys(PALETTES).sort());
    const spec = read('SPEC.md');
    for (const t of Object.keys(STYLE_TOKENS)) expect(spec, `SPEC.md does not name the style colour "${t}"`).toContain(`\`${t}\``);
    for (const p of Object.keys(PALETTES)) expect(spec).toContain(p);
  });
});
