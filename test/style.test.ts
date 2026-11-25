// The viewer's colours: `style:` in system.yaml, checked by the compiler and turned into a stylesheet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { PALETTES, STYLE_TOKENS, cssVar, isColor, lowContrast, resolveStyle, styleSheet, type StyleToken } from '../src/style.js';

let root: string;
const write = (rel: string, body: string): void => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const system = (style: string): void => write('armature/system.yaml', `name: Shop\nheadline: Takes orders.\n${style}`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-style-'));
  write('armature/nodes/api.yaml', 'kind: external\nrole: order API\n');
});

describe('style in system.yaml', () => {
  it('leaves the graph without a style when the model sets none', () => {
    system('');
    expect(compile(root).system.style).toBeUndefined();
  });

  it('lays colors over the palette, and light and dark over colors', () => {
    system('style:\n  palette: slate\n  mode: dark\n  colors:\n    accent: "#5b4bd6"\n    blue: oklch(0.6 0.15 255)\n  dark:\n    accent: "#a597ff"\n');
    const g = compile(root);
    expect(g.problems.filter((p) => p.severity === 'error')).toEqual([]);
    const s = g.system.style!;
    expect(s.palette).toBe('slate');
    expect(s.mode).toBe('dark');
    expect(s.light.accent).toBe('#5b4bd6');
    expect(s.dark.accent).toBe('#a597ff');
    expect(s.dark.blue).toBe('oklch(0.6 0.15 255)');
    expect(s.light.bg).toBe(PALETTES.slate.light.bg);
  });

  it('refuses a value that is not a colour, and an unknown colour name or palette', () => {
    system('style:\n  colors:\n    accent: "red; } body { display: none"\n');
    const bad = compile(root).problems.find((p) => p.code === 'schema')!;
    expect(bad.message).toContain('style.colors.accent');
    expect(bad.file).toBe('armature/system.yaml');
    system('style:\n  palette: neon\n  colors:\n    brand: "#fff"\n');
    const msgs = compile(root).problems.filter((p) => p.code === 'schema').map((p) => p.message).join('\n');
    expect(msgs).toMatch(/brand|additional/);
    expect(msgs).toMatch(/palette|allowed/);
  });

  it('warns when text would be hard to read', () => {
    system('style:\n  colors:\n    ink: "#cccccc"\n');
    const w = compile(root).problems.find((p) => p.code === 'style-contrast')!;
    expect(w.message).toContain('light: ink on bg');
  });

  it('keeps the built-in palettes readable', () => {
    for (const id of Object.keys(PALETTES)) expect(lowContrast(resolveStyle({ palette: id })!), id).toEqual([]);
  });
});

describe('the stylesheet', () => {
  it('uses the same selectors as the viewer for dark mode', () => {
    const css = styleSheet(resolveStyle({ colors: { accent: '#123456', teal: '#0a0' }, dark: { accent: '#abcdef' } })!);
    expect(css).toContain(':root { --accent: #123456; --c-teal: #0a0; }');
    expect(css).toContain(":root:not([data-theme='light']) { --accent: #abcdef; --c-teal: #0a0; }");
    expect(css).toContain(":root[data-theme='dark'] { --accent: #abcdef;");
  });

  it('drops anything that could break out of a declaration', () => {
    for (const v of ['red;}', 'url(x)', 'rgb(1 2 3);x', '#12345', 'var(--ink)', 'expression(alert(1))']) expect(isColor(v), v).toBe(false);
    for (const v of ['#abc', '#a1b2c3d4', 'rgb(1 2 3 / 50%)', 'hsl(200, 50%, 40%)', 'rebeccapurple']) expect(isColor(v), v).toBe(true);
    expect(styleSheet({ palette: 'paper', mode: 'auto', light: { accent: 'red;} body{x:y' } as any, dark: {} })).toBe('');
  });

  it('names a CSS variable the viewer stylesheet defines for every colour', () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, '../viewer/src/styles.css'), 'utf8');
    for (const t of Object.keys(STYLE_TOKENS) as StyleToken[]) expect(css, t).toContain(`${cssVar(t)}:`);
  });
});
