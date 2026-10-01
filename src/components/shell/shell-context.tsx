'use client';

/**
 * Shell state: what the chrome remembers between navigations.
 *
 * ONE thing lives here: whether the drawer is collapsed. The test for inclusion
 * is whether the value outlives a route change and is read by more than one part
 * of the chrome — a sidebar that forgot it was collapsed every time somebody
 * opened a password would be worse than one that does not collapse at all.
 *
 * The current organization deliberately is NOT here. It is a fact about the
 * route, so the top bar derives it from the pathname and the drawer receives it
 * as a prop from the layout that already loaded it. Pushing it into context
 * would mean a client component re-rendering the whole shell to learn something
 * the URL already said.
 *
 * WHY NOT THE URL. Collapse state is a property of the person, not the page: it
 * should not travel in a link somebody pastes into a ticket, and a querystring
 * that differs only by `?collapsed=1` makes two identical pages look like two
 * pages to every cache between here and the browser. The FILTER state is the
 * opposite case and deliberately does live in the URL — see FilterToolbar.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';

interface ShellState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);

const STORAGE_KEY = 'helm:sidebar-collapsed';

export function ShellProvider({ children }: { children: ReactNode }) {
  /*
   * Starts expanded, then corrects on mount.
   *
   * Reading localStorage during the first render would be a hydration mismatch —
   * the server has no idea what this browser remembers — so the first paint is
   * always the expanded shell and the effect below collapses it if that is what
   * the person chose. The cost is one frame; the alternative is React discarding
   * the server HTML.
   */
  const [sidebarCollapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === '1') setCollapsed(true);
    } catch {
      // Private windows and blocked site data throw on access. A shell that
      // cannot remember a preference still works; one that crashes does not.
    }
  }, []);

  const setSidebarCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* As above. */
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  const value = useMemo<ShellState>(
    () => ({ sidebarCollapsed, toggleSidebar, setSidebarCollapsed }),
    [sidebarCollapsed, toggleSidebar, setSidebarCollapsed],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside <ShellProvider>');
  return ctx;
}
