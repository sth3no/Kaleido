import { describe, expect, test } from 'vitest';

import indexHtml from '../../index.html?raw';
import settingsChangedJson from '../../src-tauri/tests/fixtures/ipc/settings.changed.json';
import type { Appearance, SystemAppearance } from '../ipc/types';
import {
  applyTokens,
  clampUiScale,
  DEFAULT_APPEARANCE,
  defaultTokens,
  effectsAvailable,
  GLASS_OPACITY_MAX,
  GLASS_TEXT_MIN_OPACITY,
  resolveMica,
  resolveReduceTransparency,
  resolveTheme,
  toCssVariables,
  tokensFromAppearance,
  type Tokens,
} from './tokens';

/** Every CSS file of the app, by path, as text. */
const stylesheets = import.meta.glob<string>('/src/**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const MODES = ['dark', 'light'] as const;

const appearance = (changes: Partial<Appearance>): Appearance => ({ ...DEFAULT_APPEARANCE, ...changes });

/** The names of the CSS variables a token tree should have, worked out independently of `toCssVariables`. */
function expectedVariables(node: object, path: string[] = []): string[] {
  return Object.entries(node as Record<string, unknown>).flatMap(([name, value]) => {
    const here = [...path, name];
    if (typeof value === 'object' && value !== null) return expectedVariables(value, here);
    return [`--k-${here.map((part) => part.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)).join('-')}`];
  });
}

describe('tokens', () => {
  test('tokens have every group from spec 8.1', () => {
    for (const mode of MODES) {
      const tokens = defaultTokens(mode);
      // Colours, glass, accent, radius, font sizes, space, shadows, motion and focus.
      expect(Object.keys(tokens).sort(), mode).toEqual([
        'accent',
        'color',
        'focus',
        'font',
        'glass',
        'motion',
        'radius',
        'shadow',
        'space',
      ]);
      // Glass: tint, opacity, blur, saturation.
      expect(Object.keys(tokens.glass).sort()).toEqual(['blur', 'opacity', 'saturation', 'tint']);
      expect(Object.keys(tokens.accent).sort()).toEqual(['gradient', 'solid']);
      expect(Object.keys(tokens.radius).sort()).toEqual(['l', 'm', 'pill', 's']);
      expect(Object.keys(tokens.font).sort()).toEqual(['family', 'size']);
      expect(Object.keys(tokens.motion).sort()).toEqual(['base', 'fast', 'slow', 'spring']);
      expect(Object.keys(tokens.focus).sort()).toEqual(['offset', 'ring']);
      expect(Object.keys(tokens.shadow).sort()).toEqual(['glass', 'popover', 'text']);
      expect(Object.keys(tokens.space).length).toBeGreaterThan(0);
      expect(Object.keys(tokens.color).length).toBeGreaterThan(0);

      // Nothing is empty, and the numbers are numbers.
      for (const [name, value] of Object.entries(tokens.color)) expect(value, `color.${name}`).not.toBe('');
      expect(tokens.glass.tint).toMatch(/^#[0-9a-f]{6}$/);
      expect(tokens.accent.solid).toMatch(/^#[0-9a-f]{6}$/);
      expect(tokens.accent.gradient).toMatch(/^linear-gradient\(/);
      expect(tokens.focus.ring).not.toBe('');
      expect(tokens.motion.spring).not.toBe('');
      for (const size of Object.values(tokens.space)) expect(size).toBeGreaterThan(0);
      // Spec 8.6: islands and panels animate in 150 to 250 ms, the longer the slower.
      const { fast, base, slow } = tokens.motion;
      expect([fast, base, slow]).toEqual([150, 200, 250]);
    }
  });

  test('font sizes match spec 8.7', () => {
    for (const mode of MODES) {
      expect(Object.values(defaultTokens(mode).font.size)).toEqual([11, 12, 13, 15, 20, 28]);
    }
    expect(defaultTokens('dark').font.family).toMatch(/^"Segoe UI Variable Text", "Segoe UI", system-ui/);
  });

  test('glass opacity never drops below the text floor', () => {
    expect(GLASS_TEXT_MIN_OPACITY).toBe(0.45);
    // The setting goes down to 0.3 (settings/store.rs); the tokens hold it at the floor.
    for (const glassOpacity of [0.3, 0.1, 0, -1, 0.44]) {
      const { opacity } = tokensFromAppearance(appearance({ glassOpacity }), 'dark').glass;
      expect(opacity, `${glassOpacity}`).toBeGreaterThanOrEqual(GLASS_TEXT_MIN_OPACITY);
    }
    expect(tokensFromAppearance(appearance({ glassOpacity: 0.3 }), 'light').glass.opacity).toBe(
      GLASS_TEXT_MIN_OPACITY,
    );
    // Above the floor the setting is kept, and the top of the range is held too.
    expect(tokensFromAppearance(appearance({ glassOpacity: 0.8 }), 'dark').glass.opacity).toBe(0.8);
    expect(tokensFromAppearance(appearance({ glassOpacity: 5 }), 'dark').glass.opacity).toBe(GLASS_OPACITY_MAX);
    // Something that is no number is the default, which is above the floor.
    const fallen = tokensFromAppearance(appearance({ glassOpacity: Number.NaN }), 'dark').glass.opacity;
    expect(fallen).toBeGreaterThanOrEqual(GLASS_TEXT_MIN_OPACITY);
    expect(fallen).toBeLessThanOrEqual(GLASS_OPACITY_MAX);
    // The default glass is within bounds in both modes.
    for (const mode of MODES) {
      const { opacity } = defaultTokens(mode).glass;
      expect(opacity).toBeGreaterThanOrEqual(GLASS_TEXT_MIN_OPACITY);
      expect(opacity).toBeLessThanOrEqual(GLASS_OPACITY_MAX);
    }
  });

  test('css variables cover every token', () => {
    for (const mode of MODES) {
      const tokens = defaultTokens(mode);
      const variables = toCssVariables(tokens);
      expect(Object.keys(variables).sort(), mode).toEqual(expectedVariables(tokens).sort());
      for (const [name, value] of Object.entries(variables)) {
        expect(name).toMatch(/^--k-[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(value, name).not.toBe('');
        expect(value, name).not.toMatch(/undefined|NaN|\[object|Infinity/);
      }
      // Lengths are px, durations ms, and a ratio stays a number.
      expect(variables['--k-font-size-m']).toBe('13px');
      expect(variables['--k-font-size-xxl']).toBe('28px');
      expect(variables['--k-motion-fast']).toBe('150ms');
      expect(variables['--k-radius-l']).toMatch(/^\d+(\.\d+)?px$/);
      expect(variables['--k-glass-blur']).toMatch(/^\d+(\.\d+)?px$/);
      expect(variables['--k-glass-opacity']).toMatch(/^\d+(\.\d+)?$/);
      expect(variables['--k-glass-saturation']).toMatch(/^\d+(\.\d+)?$/);
      expect(variables['--k-motion-spring']).toBe(tokens.motion.spring);
      expect(variables['--k-color-text-muted']).toBe(tokens.color.textMuted);
    }
  });

  test('applyTokens writes every variable to the element', () => {
    const element = document.createElement('div');
    const tokens = tokensFromAppearance(appearance({ blur: 30, radius: 12 }), 'dark');
    applyTokens(element, tokens);
    for (const [name, value] of Object.entries(toCssVariables(tokens))) {
      expect(element.style.getPropertyValue(name), name).toBe(value);
    }
    expect(element.style.getPropertyValue('--k-glass-blur')).toBe('30px');
    expect(element.style.getPropertyValue('--k-radius-l')).toBe('12px');
  });

  test('the settings reach the tokens, within the ranges Rust checks', () => {
    const tokens = tokensFromAppearance(
      appearance({ glassTint: '#102030', blur: 12, saturation: 1.1, radius: 8, glassOpacity: 0.7 }),
      'dark',
    );
    expect(tokens.glass).toEqual({ tint: '#102030', opacity: 0.7, blur: 12, saturation: 1.1 });
    expect(tokens.radius.l).toBe(8);

    // Out of range or no colour at all: held to the range, or the default.
    const wild = tokensFromAppearance(
      appearance({ glassTint: 'red', blur: 400, saturation: -3, radius: 99, accent: 'nope' }),
      'dark',
    );
    expect(wild.glass.tint).toBe(DEFAULT_APPEARANCE.glassTint);
    expect(wild.glass.blur).toBe(40);
    expect(wild.glass.saturation).toBe(0.5);
    expect(wild.radius.l).toBe(28);
    expect(wild.accent).toEqual(defaultTokens('dark').accent);
  });

  test('the accent is the rainbow for "kaleido" and one colour otherwise', () => {
    const rainbow = tokensFromAppearance(appearance({ accent: 'kaleido' }), 'dark').accent;
    // The mockups' gradient has at least three colour stops.
    expect(rainbow.gradient.match(/#[0-9a-f]{6}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(rainbow.solid).toMatch(/^#[0-9a-f]{6}$/);

    const orange = tokensFromAppearance(appearance({ accent: '#FF8800' }), 'dark');
    expect(orange.accent.solid).toBe('#ff8800');
    expect(orange.accent.gradient).toContain('#ff8800');
    expect(orange.accent.gradient).not.toBe(rainbow.gradient);
    // The focus ring is the accent, and text on it reads (one of the two ends of the scale).
    expect(orange.focus.ring).toContain('#ff8800');
    expect(['#ffffff', '#2a1d4d']).toContain(orange.color.onAccent);
  });

  test('corner radii follow the setting and keep their order', () => {
    for (const radius of [0, 4, 12, 20, 28]) {
      const { s, m, l, pill } = tokensFromAppearance(appearance({ radius }), 'dark').radius;
      expect(l).toBe(radius);
      expect(s).toBeLessThanOrEqual(m);
      expect(m).toBeLessThanOrEqual(l);
      expect(pill).toBeGreaterThanOrEqual(l);
    }
    // Square corners are square, also for the capsules.
    expect(tokensFromAppearance(appearance({ radius: 0 }), 'dark').radius.pill).toBe(0);
    expect(tokensFromAppearance(appearance({ radius: 1 }), 'dark').radius.pill).toBeGreaterThan(100);
  });

  test('text on glass is light on a dark tint and dark on a light one', () => {
    const dark = tokensFromAppearance(appearance({ glassTint: '#16161c' }), 'dark');
    const light = tokensFromAppearance(appearance({ glassTint: '#ffffff' }), 'dark');
    expect(dark.color.onGlass).not.toBe(light.color.onGlass);
    expect(dark.color.onGlass).toBe('#ffffff');
    // The text shadow sets the text off, so it is the other way round.
    expect(dark.shadow.text).not.toBe(light.shadow.text);
  });

  test('the modes differ and the light mode has a light glass', () => {
    const dark = defaultTokens('dark');
    const light = defaultTokens('light');
    expect(dark.color.bg).not.toBe(light.color.bg);
    expect(dark.color.text).not.toBe(light.color.text);
    expect(dark.glass.tint).not.toBe(light.glass.tint);
  });

  test('in the light mode the default glass tint is white, and a tint the user chose stays (R35)', () => {
    const light = tokensFromAppearance(DEFAULT_APPEARANCE, 'light');
    const dark = tokensFromAppearance(DEFAULT_APPEARANCE, 'dark');
    expect(light.glass.tint).toBe('#ffffff');
    expect(dark.glass.tint).toBe(DEFAULT_APPEARANCE.glassTint);
    // Text on the white glass is the other one than on the dark glass.
    expect(light.color.onGlass).not.toBe(dark.color.onGlass);

    // defaultTokens is the same rule, not another one.
    expect(defaultTokens('light')).toEqual(light);
    expect(defaultTokens('dark')).toEqual(dark);

    // The same default as another spelling of it, or a tint that is no colour (the default then).
    expect(tokensFromAppearance(appearance({ glassTint: '#16161C' }), 'light').glass.tint).toBe('#ffffff');
    expect(tokensFromAppearance(appearance({ glassTint: 'red' }), 'light').glass.tint).toBe('#ffffff');

    // A chosen tint applies in both modes.
    for (const mode of MODES) {
      for (const glassTint of ['#102030', '#c9b8ff', '#222222', '#FFFFFF']) {
        const tint = tokensFromAppearance(appearance({ glassTint }), mode).glass.tint;
        expect(tint, `${mode} ${glassTint}`).toBe(glassTint.toLowerCase());
      }
    }
  });

  test('the focus ring stands out from the page by 3:1 in both modes', () => {
    // WCAG relative luminance and contrast ratio, written out here on their own.
    const channel = (value: number) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const luminanceOf = (hex: string) => {
      const rgb = Number.parseInt(hex.slice(1), 16);
      return 0.2126 * channel((rgb >> 16) & 255) + 0.7152 * channel((rgb >> 8) & 255) + 0.0722 * channel(rgb & 255);
    };
    const ratio = (first: string, second: string) => {
      const [a, b] = [luminanceOf(first), luminanceOf(second)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    const accents = ['kaleido', '#a98bff', '#ff8800', '#102030', '#ffffff', '#000000', '#f4f2fb', '#15122b'];
    for (const mode of MODES) {
      for (const accent of accents) {
        const tokens = tokensFromAppearance(appearance({ accent }), mode);
        const ring = /^2px solid (#[0-9a-f]{6})$/.exec(tokens.focus.ring)?.[1];
        expect(ring, `${mode} ${accent}: ${tokens.focus.ring}`).toBeDefined();
        expect(ratio(ring ?? '', tokens.color.bg), `${mode} ${accent}: ${tokens.focus.ring}`).toBeGreaterThanOrEqual(3);
      }
    }

    // On the dark page the kaleido violet is enough as it is; on the light page it is darker.
    const dark = defaultTokens('dark');
    const light = defaultTokens('light');
    expect(dark.focus.ring).toBe(`2px solid ${dark.accent.solid}`);
    expect(light.focus.ring).not.toBe(`2px solid ${light.accent.solid}`);
  });

  test('the defaults here are the defaults of the settings in Rust', () => {
    // The first sample of settings:changed is `Settings::default()` as Rust serializes it.
    const [rustDefaults] = settingsChangedJson;
    expect(DEFAULT_APPEARANCE).toEqual(rustDefaults?.appearance);
  });
});

describe('reading the settings and Windows', () => {
  test('reduce transparency auto follows Windows', () => {
    expect(resolveReduceTransparency('auto', false)).toBe(true);
    expect(resolveReduceTransparency('auto', true)).toBe(false);
    expect(resolveReduceTransparency('off', false)).toBe(false);
    // The user's word wins over Windows.
    expect(resolveReduceTransparency('off', true)).toBe(false);
    expect(resolveReduceTransparency('on', true)).toBe(true);
    expect(resolveReduceTransparency('on', false)).toBe(true);
  });

  test('effects are there with the switch on and no high contrast', () => {
    const windows = (changes: Partial<SystemAppearance>): SystemAppearance => ({
      transparencyEffects: true,
      highContrast: false,
      windowsBuild: 22631,
      ...changes,
    });
    expect(effectsAvailable(windows({}))).toBe(true);
    expect(effectsAvailable(windows({ transparencyEffects: false }))).toBe(false);
    expect(effectsAvailable(windows({ highContrast: true }))).toBe(false);
  });

  test('Mica needs the switch, Windows 11 and transparency that is not reduced', () => {
    const windows = (windowsBuild: number): SystemAppearance => ({
      transparencyEffects: true,
      highContrast: false,
      windowsBuild,
    });
    expect(resolveMica({ mica: true }, windows(22631), false)).toBe(true);
    expect(resolveMica({ mica: true }, windows(22000), false)).toBe(true);
    expect(resolveMica({ mica: true }, windows(21999), false)).toBe(false);
    expect(resolveMica({ mica: true }, windows(19045), false)).toBe(false);
    expect(resolveMica({ mica: true }, windows(0), false)).toBe(false);
    expect(resolveMica({ mica: false }, windows(22631), false)).toBe(false);
    expect(resolveMica({ mica: true }, windows(22631), true)).toBe(false);
  });

  test('the mode "system" follows the colour scheme of Windows', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  test('ui scale is clamped to 90–150 %', () => {
    expect(clampUiScale(0.5)).toBe(0.9);
    expect(clampUiScale(0)).toBe(0.9);
    expect(clampUiScale(2)).toBe(1.5);
    expect(clampUiScale(100)).toBe(1.5);
    // Inside the range, and the ends of it, as they are.
    expect(clampUiScale(0.9)).toBe(0.9);
    expect(clampUiScale(1)).toBe(1);
    expect(clampUiScale(1.25)).toBe(1.25);
    expect(clampUiScale(1.5)).toBe(1.5);
    // No number: 100 %.
    expect(clampUiScale(Number.NaN)).toBe(1);
  });
});

describe('the stylesheets', () => {
  /** The text of a stylesheet without its comments. */
  const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

  /** `transform: … scale(` (also scale3d, scaleX…) and the `scale:` property. */
  const SCALES =
    /transform\s*:[^;{}]*\bscale(?:3d|[xyz])?\s*\(|(?:^|[;{\s])scale\s*:/i;

  test('the finder of scaling finds it', () => {
    // So that the next test cannot pass because the pattern never matches.
    expect(SCALES.test('.a { transform: translateX(1px) scale(1.1); }')).toBe(true);
    expect(SCALES.test('.a { transform: scale3d(1, 1, 1) }')).toBe(true);
    expect(SCALES.test('.a { transition: transform 1s; scale: 1.2; }')).toBe(true);
    expect(SCALES.test('.a { zoom: var(--k-ui-scale, 1); transform: translateX(2px); }')).toBe(false);
  });

  /** The text of the stylesheet whose path ends with `suffix`; "" if there is none. */
  const stylesheet = (suffix: string): string =>
    Object.entries(stylesheets).find(([path]) => path.endsWith(suffix))?.[1] ?? '';

  test('the stylesheets come as text (vite.config.ts lets ?raw CSS through vitest)', () => {
    const files = Object.entries(stylesheets);
    // global.css, glass.module.css and App.module.css at least: the glob found the files.
    expect(files.length).toBeGreaterThanOrEqual(3);
    // Vitest blanks CSS ("" for a stylesheet, a proxy of class names for a CSS module) unless
    // test.css.include says otherwise; every other test of this file would then pass on nothing.
    for (const [path, css] of files) {
      expect(css, path).toBeTypeOf('string');
      expect(css.length, `${path} is empty: vitest did not give its text`).toBeGreaterThan(0);
    }
    // Real text of the files, not just any text.
    expect(stylesheet('/theme/global.css')).toContain(':focus-visible');
    expect(stylesheet('/theme/glass.module.css')).toContain('.glass');
    expect(stylesheet('/App.module.css')).toContain('.root');
  });

  test('no transform: scale in any stylesheet', () => {
    const files = Object.entries(stylesheets);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const [path, css] of files) {
      expect(css.length, `${path} is empty`).toBeGreaterThan(0);
      // A transform: scale on an ancestor of an element with backdrop-filter breaks the blur in
      // WebView2 (spec 8.2): zoom is what the UI uses.
      expect(SCALES.test(code(css)), `${path} scales with a transform`).toBe(false);
    }
  });

  test('the stylesheets use only the variables the tokens define', () => {
    const tokenVariables = new Set([
      ...Object.keys(toCssVariables(defaultTokens('dark'))),
      // Not tokens: the scale the root gets from the settings, and the page background global.css derives.
      '--k-ui-scale',
      '--k-backdrop',
    ]);
    const used = new Set<string>();
    for (const [path, css] of Object.entries(stylesheets)) {
      expect(css.length, `${path} is empty`).toBeGreaterThan(0);
      for (const match of code(css).matchAll(/var\(\s*(--k-[a-z0-9-]+)/g)) {
        expect(tokenVariables.has(match[1] ?? ''), `${path} reads ${match[1]}`).toBe(true);
        used.add(match[1] ?? '');
      }
      for (const match of code(css).matchAll(/(--k-[a-z0-9-]+)\s*:/g)) {
        expect(tokenVariables.has(match[1] ?? ''), `${path} sets ${match[1]}`).toBe(true);
      }
    }
    // The glass reads its tokens: the check above looked at something.
    expect(used.has('--k-glass-tint')).toBe(true);
    expect(used.has('--k-glass-opacity')).toBe(true);
    expect(used.has('--k-focus-ring')).toBe(true);
  });

  test('global.css has the font, tabular numbers, reduced motion, forced colours and the focus', () => {
    const globalCss = stylesheet('/theme/global.css');
    expect(globalCss.length).toBeGreaterThan(0);
    expect(globalCss).toContain('Segoe UI Variable Text');
    expect(globalCss).toMatch(/\.tabular\s*\{[^}]*tabular-nums/);
    expect(globalCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(globalCss).toContain('@media (forced-colors: active)');
    expect(globalCss).toMatch(/:focus-visible\s*\{[^}]*var\(--k-focus-ring\)/);
    expect(globalCss).toMatch(/zoom:\s*var\(--k-ui-scale/);
  });

  test('glass.module.css has the opaque variant for reduced transparency', () => {
    const glassCss = stylesheet('/theme/glass.module.css');
    expect(glassCss.length).toBeGreaterThan(0);
    expect(glassCss).toMatch(/\.glass\s*\{[^}]*backdrop-filter:\s*blur\(/);
    expect(glassCss).toMatch(/:global\(\[data-reduce-transparency\]\)\s+\.glass\s*\{[^}]*backdrop-filter:\s*none/);
  });
});

describe('index.html', () => {
  test('paints the dark token before the bundle has loaded, and the light one for a light system', () => {
    const colours = [...indexHtml.matchAll(/background:\s*(#[0-9a-f]{6})/gi)].map((match) => (match[1] ?? '').toLowerCase());
    const tokens: Record<'dark' | 'light', Tokens> = { dark: defaultTokens('dark'), light: defaultTokens('light') };
    expect(colours).toEqual([tokens.dark.color.bg, tokens.light.color.bg]);
  });
});
