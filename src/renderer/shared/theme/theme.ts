import { useEffect, useState } from '../../vendor/preact-hooks.js';
import type { Theme } from '../../../shared/api.js';

export type Appearance = 'light' | 'dark';

const query = matchMedia('(prefers-color-scheme: dark)');

/**
 * Light or dark, following the app's Theme setting: main applies it to nativeTheme, which drives
 * prefers-color-scheme here. Dark is the design's canonical theme; light adds `.light` to `.win`.
 */
export function useAppearance(): Appearance {
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const onChange = () => setDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return dark ? 'dark' : 'light';
}

/** The Theme setting and a way to change it, in the app's settings. Null until known. */
export function useThemeSetting(): [Theme | null, (theme: Theme) => void] {
  const [saved, setSaved] = useState<Theme | null>(null);
  useEffect(() => { window.journey.settings.get().then((s) => setSaved(s.theme), () => setSaved(null)); }, []);
  const pick = (theme: Theme) => {
    setSaved(theme);
    void window.journey.settings.update({ theme });
  };
  return [saved, pick];
}
