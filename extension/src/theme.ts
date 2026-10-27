/**
 * Light, dark, or whatever the system says. The setting lives with the others
 * in chrome.storage; a copy in localStorage lets a page apply it before its
 * first paint, since chrome.storage only answers asynchronously and a popup
 * that opens white and turns dark is the thing dark mode is meant to avoid.
 */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'helm-theme';

export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // A page without localStorage still themes once chrome.storage answers.
  }
}

/** The last theme this page saw, applied synchronously. */
export function applyRememberedTheme(): void {
  let theme: string | null = null;
  try {
    theme = localStorage.getItem(KEY);
  } catch {
    return;
  }
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
}
