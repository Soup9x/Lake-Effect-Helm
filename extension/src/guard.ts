/**
 * Clicks in a frame the extension draws over a page (menu.html, notify.html)
 * count only when the frame can actually be seen.
 *
 * A page can put the extension's frame under something transparent, fade it
 * to nothing, or slide it under the pointer just before a click, and so have
 * the person press Fill or Save without knowing. Bitwarden guards its inline
 * menu against the same. Here the browser says whether this frame is visible
 * and unobscured (IntersectionObserver with trackVisibility), and a click is
 * ignored while it is not, and for the first half second after the frame
 * appears.
 */
const OPENED = Date.now();
let visible = true;

try {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const isVisible = (entry as IntersectionObserverEntry & { isVisible?: boolean }).isVisible;
        visible = isVisible ?? entry.isIntersecting;
      }
    },
    { threshold: 0, trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  );
  observer.observe(document.documentElement);
} catch {
  // A browser without trackVisibility: the time rule still applies.
}

export function clickCounts(): boolean {
  return visible && Date.now() - OPENED > 500;
}
