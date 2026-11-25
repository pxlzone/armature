// Secondary view options, kept out of the toolbar in one popover under the Settings button.
// Choices are remembered per browser.
import { useEffect, useRef } from 'react';
import { IconSettings, IconX } from '@tabler/icons-react';
import { PALETTES } from '../../src/style.ts';

export type LineMode = 'auto' | 'merged' | 'separate';
export type Motion = 'off' | 'active' | 'all';
/** auto: what the model's style: says, else the reader's system. */
export type Theme = 'auto' | 'light' | 'dark';
/** model: the model's style: block. Any other value is a built-in palette, for this browser only. */
export type Palette = 'model' | string;

export interface ViewSettings {
  hidePlanned: boolean;
  showLibs: boolean;
  lineMode: LineMode;
  motion: Motion;
  zoomOpens: boolean;
  follow: boolean;
  legend: boolean;
  theme: Theme;
  palette: Palette;
}

// Only choices that differ from the defaults are stored, so a changed default reaches everyone who
// did not pick that option themselves. v2: earlier saves stored every field, defaults included.
const KEY = 'armature.settings.v2';

export function defaultSettings(): ViewSettings {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return { hidePlanned: false, showLibs: false, lineMode: 'auto', motion: reduced ? 'off' : 'active', zoomOpens: false, follow: true, legend: true, theme: 'auto', palette: 'model' };
}

export function loadSettings(): ViewSettings {
  const base = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const out = { ...base };
    for (const k of Object.keys(base) as Array<keyof ViewSettings>) if (typeof saved[k] === typeof base[k]) (out as any)[k] = saved[k];
    return out;
  } catch {
    return base;
  }
}

export function saveSettings(s: ViewSettings): void {
  try {
    const d = defaultSettings();
    const diff = Object.fromEntries(Object.entries(s).filter(([k, v]) => d[k as keyof ViewSettings] !== v));
    localStorage.setItem(KEY, JSON.stringify(diff));
  } catch {
    /* storage blocked: settings last for this visit */
  }
}

/** Settings that change what is on the map, so the button can say a filter is on. */
export function changedFromDefault(s: ViewSettings): string[] {
  const d = defaultSettings();
  const out: string[] = [];
  if (s.hidePlanned !== d.hidePlanned) out.push('built only');
  if (s.showLibs !== d.showLibs) out.push('libraries shown');
  if (s.lineMode !== d.lineMode) out.push(`${s.lineMode} lines`);
  if (s.motion !== d.motion) out.push(`motion ${s.motion}`);
  if (s.zoomOpens !== d.zoomOpens) out.push('zoom opens groups');
  if (s.follow !== d.follow) out.push('camera stays');
  if (s.legend !== d.legend) out.push('no legend');
  if (s.theme !== d.theme) out.push(`${s.theme} theme`);
  if (s.palette !== d.palette) out.push(`${PALETTES[s.palette]?.title ?? s.palette} palette`);
  return out;
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string, string]>; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text, title]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} title={title} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        <div className="set-help">{help}</div>
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function SettingsButton({ open, setOpen, changed }: { open: boolean; setOpen: (v: boolean) => void; changed: string[] }) {
  return (
    <button
      className={`chip settings-btn${open ? ' on' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="view-settings"
      title={changed.length ? `Settings (changed: ${changed.join(', ')})` : 'Settings'}
      onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
    >
      <IconSettings size={15} stroke={1.8} />
      Settings
      {changed.length > 0 && <i className="settings-dot" aria-label={`${changed.length} changed`} />}
    </button>
  );
}

export function SettingsDialog({ s, set, plannedCount, modelPalette, onClose }: { s: ViewSettings; set: (patch: Partial<ViewSettings>) => void; plannedCount: number; modelPalette?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button[aria-checked="true"], button')?.focus();
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    const down = (e: PointerEvent): void => {
      const t = e.target as Element | null;
      if (ref.current && t && !ref.current.contains(t) && !t.closest('.settings-btn')) onClose();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', down);
    };
  }, [onClose]);
  const d = defaultSettings();
  return (
    <div className="settings" id="view-settings" role="dialog" aria-label="View settings" ref={ref}>
      <div className="set-head">
        <span>View settings</span>
        <button className="set-close" onClick={onClose} aria-label="Close settings"><IconX size={16} /></button>
      </div>

      <section>
        <h3>What the map shows</h3>
        <Row title="Planned work" help="Planned parts are drawn as dashed outlines. Built today hides them.">
          <Seg label="Planned work" value={s.hidePlanned ? 'built' : 'plans'} onChange={(v) => set({ hidePlanned: v === 'built' })} options={[['plans', `With plans${plannedCount ? ` (${plannedCount})` : ''}`, 'Show planned parts as dashed outlines'], ['built', 'Built today', 'Show only what exists in the code today']]} />
        </Row>
        <Row title="Shared libraries" help="Code packages used by many services. Hidden by default to keep the map readable.">
          <Toggle label="Show shared libraries" checked={s.showLibs} onChange={(v) => set({ showLibs: v })} />
        </Row>
        <Row title="Legend" help="The key to borders and line styles, bottom right.">
          <Toggle label="Show the legend" checked={s.legend} onChange={(v) => set({ legend: v })} />
        </Row>
      </section>

      <section>
        <h3>Lines and motion</h3>
        <Row title="Lines" help="Auto merges lines into trunks when zoomed out and separates them up close.">
          <Seg label="Lines" value={s.lineMode} onChange={(v) => set({ lineMode: v })} options={[['auto', 'Auto', 'Merged when zoomed out, separate when zoomed in'], ['merged', 'Merged', 'One line per pair of nodes, sharing trunks'], ['separate', 'Separate', 'Every link on its own, with its data label']]} />
        </Row>
        <Row title="Data motion" help="Dots travel the way data goes. Active moves only what you hover, select or play.">
          <Seg label="Data motion" value={s.motion} onChange={(v) => set({ motion: v })} options={[['off', 'Off', 'Nothing moves'], ['active', 'Active', 'Only the links in focus'], ['all', 'All', 'Every built link']]} />
        </Row>
      </section>

      <section>
        <h3>Appearance</h3>
        <Row title="Theme" help="Auto follows the model's style: in system.yaml, and otherwise this computer's light or dark setting.">
          <Seg label="Theme" value={s.theme} onChange={(v) => set({ theme: v })} options={[['auto', 'Auto', 'As the model or this computer says'], ['light', 'Light', 'Always light'], ['dark', 'Dark', 'Always dark']]} />
        </Row>
        <Row title="Palette" help={`From model uses the colours in system.yaml${modelPalette ? ` (${PALETTES[modelPalette]?.title ?? modelPalette} with its changes)` : ', none set'}. Another palette applies in this browser only.`}>
          <select className="set-select" aria-label="Palette" value={s.palette} onChange={(e) => set({ palette: e.target.value })}>
            <option value="model">From model</option>
            {Object.entries(PALETTES).map(([id, p]) => <option key={id} value={id}>{p.title}</option>)}
          </select>
        </Row>
      </section>

      <section>
        <h3>Navigation</h3>
        <Row title="Zoom opens groups" help="Off by default. When on, zooming into a group opens it and zooming out closes it again. Double-click or + always opens a group.">
          <Toggle label="Zoom opens groups" checked={s.zoomOpens} onChange={(v) => set({ zoomOpens: v })} />
        </Row>
        <Row title="Follow flow steps" help="While a flow plays, the camera moves to each step.">
          <Toggle label="Camera follows flow steps" checked={s.follow} onChange={(v) => set({ follow: v })} />
        </Row>
      </section>

      <div className="set-foot">
        <button className="chip" disabled={JSON.stringify(s) === JSON.stringify(d)} onClick={() => set(d)}>Reset to defaults</button>
      </div>
    </div>
  );
}
