import { useEffect, useState } from '../../vendor/preact-hooks.js';
import { Store, useStore } from '../store.js';
import type { Theme } from '../../../shared/api.js';

export type Appearance = 'light' | 'dark';

const query = matchMedia('(prefers-color-scheme: dark)');
const KEY = 'vowe.theme';

/**
 * Where there is no main process to ask (the development preview, or a plain browser), the theme is
 * kept here instead of in the app's settings.
 */
export const localTheme = new Store<{ theme: Theme }>({ theme: (() => { try { return (localStorage.getItem(KEY) as Theme) || 'system'; } catch { return 'system'; } })() });
localTheme.subscribe(() => { try { localStorage.setItem(KEY, localTheme.state.theme); } catch { /* storage may be unavailable */ } });

/**
 * Light or dark, following the app's Theme setting: main applies it to nativeTheme, which drives
 * prefers-color-scheme here. Dark is the design's canonical theme; light adds `.light` to `.win`.
 */
export function useAppearance(): Appearance {
  const [dark, setDark] = useState(query.matches);
  const { theme } = useStore(localTheme);
  useEffect(() => {
    const onChange = () => setDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  if (!window.journey && theme !== 'system') return theme;
  return dark ? 'dark' : 'light';
}

/** The Theme setting and a way to change it: the app's settings, or localTheme in the preview. Null until known. */
export function useThemeSetting(): [Theme | null, (theme: Theme) => void] {
  const local = useStore(localTheme);
  const [saved, setSaved] = useState<Theme | null>(null);
  useEffect(() => { if (window.journey) window.journey.settings.get().then((s) => setSaved(s.theme), () => setSaved(null)); }, []);
  const pick = (theme: Theme) => {
    if (!window.journey) { localTheme.setState({ theme }); return; }
    setSaved(theme);
    void window.journey.settings.update({ theme });
  };
  return [window.journey ? saved : local.theme, pick];
}
