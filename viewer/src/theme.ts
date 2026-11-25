// Lays the model's colours, or a palette picked in Settings, over the viewer's stylesheet.
import { resolveStyle, styleSheet, type Style } from '../../src/style.ts';
import type { ViewSettings } from './Settings.tsx';

const ID = 'armature-style';

export function applyStyle(model: Style | undefined, s: Pick<ViewSettings, 'theme' | 'palette'>): void {
  const style = s.palette === 'model' ? model : resolveStyle({ palette: s.palette });
  const mode = s.theme !== 'auto' ? s.theme : model?.mode ?? 'auto';
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  let el = document.getElementById(ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = ID;
    document.head.appendChild(el);
  }
  el.textContent = style ? styleSheet(style) : '';
}
