import type { ReactNode } from 'react';
import {
  getServerIdentity,
  NoMembershipError,
  NotAuthenticatedError,
} from '@/lib/auth/server-identity';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { SignedOut } from '@/components/signed-out';

/**
 * Print views: a page with none of the app's chrome, for the browser to turn
 * into paper or a PDF.
 *
 * Identity is resolved here as the (app) layout does it, so a print view is
 * exactly as authenticated as the page it was opened from; the data still
 * comes through withTenant() in the page, which is what enforces anything.
 *
 * ALWAYS LIGHT. A PDF of a runbook in dark mode is grey text on a black page
 * that nobody can print. The script runs before first paint and overrides
 * whatever the root layout's theme script just chose.
 */
const LIGHT_SCRIPT = `document.documentElement.setAttribute('data-theme','light');`;

export default async function PrintLayout({ children }: { children: ReactNode }) {
  await installSessionResolver();
  try {
    await getServerIdentity();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return <SignedOut reason="unauthenticated" />;
    if (error instanceof NoMembershipError) return <SignedOut reason="no-membership" />;
    throw error;
  }
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant with no interpolated input */}
      <script dangerouslySetInnerHTML={{ __html: LIGHT_SCRIPT }} />
      {/* The page's margins, so a PDF saved with the dialog's defaults still has a white border. */}
      <style>{'@page { margin: 16mm 14mm; }'}</style>
      <div className="min-h-screen bg-white text-ink">{children}</div>
    </>
  );
}
