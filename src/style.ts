// The viewer's colours: built-in palettes and the `style:` block of system.yaml.
// Imported by the compiler and by the viewer, so it has no Node imports.

/** Every colour a palette can set, by its name in system.yaml. Each is a CSS variable in the viewer. */
export const STYLE_TOKENS = {
  bg: 'page background, around the map',
  canvas: 'the map itself',
  panel: 'side panel, toolbar and popovers',
  tile: 'node tiles',
  ink: 'main text',
  'ink-2': 'secondary text',
  'ink-3': 'quiet text, planned outlines',
  line: 'borders and dividers',
  'line-2': 'stronger borders, idle links',
  accent: 'selection, active flow, links in focus',
  'accent-bg': 'background behind accented things',
  red: 'failing',
  'red-bg': 'background behind failing things',
  amber: 'stale, waiting',
  'amber-bg': 'background behind stale things',
  ok: 'verified',
  heat: 'activity and test heat',
  green: 'group hue',
  blue: 'group hue',
  teal: 'group hue',
  purple: 'group hue',
  pink: 'group hue',
  orange: 'group hue',
  gray: 'group hue',
} as const;

export type StyleToken = keyof typeof STYLE_TOKENS;
export type Colors = Partial<Record<StyleToken, string>>;
export type StyleMode = 'auto' | 'light' | 'dark';

/** The CSS variable behind a token: group hues are --c-<hue>, the rest --<token>. */
export function cssVar(t: StyleToken): string {
  return ['green', 'blue', 'teal', 'purple', 'pink', 'orange', 'gray'].includes(t) ? `--c-${t}` : `--${t}`;
}

/**
 * Built-in palettes. `paper` is the viewer's own stylesheet (viewer/src/styles.css), so it sets
 * nothing here; the others list what they change from it.
 */
export const PALETTES: Record<string, { title: string; light: Colors; dark: Colors }> = {
  paper: { title: 'Paper', light: {}, dark: {} },
  slate: {
    title: 'Slate',
    light: {
      bg: '#eef1f5', canvas: '#f7f9fb', panel: '#ffffff', tile: '#ffffff', ink: '#141a22', 'ink-2': '#4a5566', 'ink-3': '#7b8696',
      line: '#d5dbe3', 'line-2': '#aeb8c5', accent: '#2f6fde', 'accent-bg': '#e1ebfb', heat: '#2f6fde',
    },
    dark: {
      bg: '#11151b', canvas: '#161b22', panel: '#1c222b', tile: '#222a34', ink: '#e8edf3', 'ink-2': '#aab4c2', 'ink-3': '#7d8898',
      line: '#2b333e', 'line-2': '#48525f', accent: '#6ea2ff', 'accent-bg': '#1a2c4a', heat: '#6ea2ff',
    },
  },
  contrast: {
    title: 'High contrast',
    light: {
      bg: '#ffffff', canvas: '#ffffff', panel: '#ffffff', tile: '#ffffff', ink: '#000000', 'ink-2': '#262626', 'ink-3': '#4d4d4d',
      line: '#8c8c8c', 'line-2': '#4d4d4d', accent: '#0050c8', 'accent-bg': '#dbe7ff', red: '#b3001b', amber: '#8a5200', ok: '#00702a', heat: '#0050c8',
    },
    dark: {
      bg: '#000000', canvas: '#000000', panel: '#0d0d0d', tile: '#111111', ink: '#ffffff', 'ink-2': '#e0e0e0', 'ink-3': '#b3b3b3',
      line: '#666666', 'line-2': '#b3b3b3', accent: '#66a3ff', 'accent-bg': '#0a2652', red: '#ff6b6b', amber: '#ffb347', ok: '#5ee08a', heat: '#66a3ff',
    },
  },
};

/** The `style:` block of system.yaml, after the compiler has checked it. */
export interface StyleInput {
  palette?: string;
  mode?: StyleMode;
  colors?: Colors;
  light?: Colors;
  dark?: Colors;
}

/** What the viewer applies: the colours that differ from its stylesheet, per mode. */
export interface Style {
  palette: string;
  mode: StyleMode;
  light: Colors;
  dark: Colors;
}

// Hex, or a CSS colour function of numbers, or a plain colour name. Nothing that could close a
// declaration: the viewer writes these into a stylesheet.
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[-+0-9.%a-z\s,/]*\)$/i;
const NAME = /^[a-z]{3,20}$/i;

export function isColor(v: unknown): v is string {
  return typeof v === 'string' && (HEX.test(v) || FUNC.test(v) || NAME.test(v));
}

/** The colours for each mode: palette, then `colors:` for both modes, then `light:` and `dark:`. */
export function resolveStyle(input: StyleInput | undefined): Style | undefined {
  if (!input) return undefined;
  const palette = input.palette && PALETTES[input.palette] ? input.palette : 'paper';
  const p = PALETTES[palette];
  const clean = (c: Colors | undefined): Colors => Object.fromEntries(Object.entries(c ?? {}).filter(([k, v]) => k in STYLE_TOKENS && isColor(v)));
  return {
    palette,
    mode: input.mode ?? 'auto',
    light: { ...p.light, ...clean(input.colors), ...clean(input.light) },
    dark: { ...p.dark, ...clean(input.colors), ...clean(input.dark) },
  };
}

/** A stylesheet that lays a style over the viewer's own, with the same selectors it uses for dark mode. */
export function styleSheet(s: Style): string {
  const decl = (c: Colors): string => Object.entries(c).filter(([k, v]) => k in STYLE_TOKENS && isColor(v)).map(([k, v]) => `${cssVar(k as StyleToken)}: ${v};`).join(' ');
  const light = decl(s.light);
  const dark = decl(s.dark);
  const out: string[] = [];
  if (light) out.push(`:root { ${light} }`);
  if (dark) out.push(`@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { ${dark} } }`, `:root[data-theme='dark'] { ${dark} }`);
  return out.join('\n');
}

/** WCAG contrast ratio of two hex colours, or undefined when either is not hex. */
export function contrast(a: string | undefined, b: string | undefined): number | undefined {
  const lum = (h: string | undefined): number | undefined => {
    if (!h || !HEX.test(h)) return undefined;
    let x = h.slice(1);
    if (x.length <= 4) x = [...x.slice(0, 3)].map((c) => c + c).join('');
    const ch = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const la = lum(a);
  const lb = lum(b);
  if (la === undefined || lb === undefined) return undefined;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The stylesheet's own values for the colours text sits on, so a style that changes only one side
// of a pair can still be checked.
const BASE: Record<'light' | 'dark', Colors> = {
  light: { bg: '#f4efe4', canvas: '#fbf8f1', panel: '#fffdf8', tile: '#ffffff', ink: '#1d1b18', 'ink-2': '#5c574e' },
  dark: { bg: '#171614', canvas: '#1d1c19', panel: '#22201d', tile: '#2a2824', ink: '#f0ece3', 'ink-2': '#b8b2a5' },
};

/** Text and background pairs in a style that are hard to read: main text under 4.5:1, secondary under 3:1. */
export function lowContrast(s: Style): string[] {
  const out: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const c = { ...BASE[mode], ...s[mode] };
    for (const back of ['bg', 'canvas', 'panel', 'tile'] as const) {
      for (const [text, min] of [['ink', 4.5], ['ink-2', 3]] as const) {
        const r = contrast(c[text], c[back]);
        if (r !== undefined && r < min) out.push(`${mode}: ${text} on ${back} is ${r.toFixed(1)}:1, under ${min}:1`);
      }
    }
  }
  return out;
}
