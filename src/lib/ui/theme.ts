/**
 * The per-browser theme choice: where it is stored, and the script that
 * applies it before first paint.
 *
 * A PLAIN MODULE, NOT 'use client', and that is the point of it living here.
 * THEME_SCRIPT used to be exported from components/theme-toggle.tsx, which is a
 * client module. When a server component (the root layout) imports a value
 * from a client module, the bundler replaces every export with a client
 * reference — so the layout received a function stub whose source text was
 * "Attempted to call THEME_SCRIPT() from the server…", rendered it as the
 * inline script, and the stored theme was never applied before paint. The
 * production build contained exactly that stub. tests/unit/client-imports.test.ts
 * now refuses any server module importing a non-component value from a client
 * module.
 */

/** localStorage key for this browser's explicit choice. */
export const THEME_STORAGE_KEY = 'helm.theme';

/**
 * Applied before first paint, in the document head.
 *
 * Without this the page renders light, then the toggle's effect runs and flips
 * it to dark — a white flash on every navigation for anybody who chose dark,
 * which is exactly the thing dark mode is meant to avoid. It has to be a
 * blocking inline script for the same reason: anything deferred is already too
 * late.
 *
 * Wrapped in try/catch because reading localStorage throws outright in some
 * privacy configurations, and a theme preference must never be the reason a
 * credential vault fails to render.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`;
