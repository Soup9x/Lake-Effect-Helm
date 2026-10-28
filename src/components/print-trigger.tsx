'use client';

/**
 * The print view's toolbar, and the print dialog opened for you.
 *
 * The dialog waits for the document to be on the page: the body is rendered
 * by the editor after hydration, and its images are attachments fetched from
 * the server, so printing on mount would produce a PDF with blank boxes where
 * the screenshots go. It waits for the editor's content and then for every
 * image to load or fail, with a ceiling so a broken image cannot hold it
 * forever.
 *
 * The toolbar is hidden from print, and stays on screen in case the browser
 * blocked the automatic dialog or the person closed it and wants it back.
 */
import { useEffect } from 'react';
import { Printer } from 'lucide-react';
import { Button } from './ui/button';

async function whenReady(): Promise<void> {
  const started = Date.now();
  while (!document.querySelector('.prose-helm') && Date.now() - started < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const pending = [...document.images].filter((img) => !img.complete);
  await Promise.race([
    Promise.all(pending.map((img) => new Promise((r) => { img.onload = r; img.onerror = r; }))),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
}

export function PrintTrigger({ backHref }: { backHref: string }) {
  useEffect(() => {
    let cancelled = false;
    void whenReady().then(() => { if (!cancelled) window.print(); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-ink-muted print:hidden">
      <span>To save a PDF, choose <span className="font-medium text-ink">Save as PDF</span> as the printer.</span>
      <span className="flex gap-2">
        <Button asChild variant="ghost" size="sm"><a href={backHref}>Back to the document</a></Button>
        <Button variant="primary" size="sm" onClick={() => window.print()}>
          <Printer aria-hidden /> Print or save as PDF
        </Button>
      </span>
    </div>
  );
}
