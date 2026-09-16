import type { Metadata, Viewport } from 'next';
import './globals.css';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Lake Effect Helm',
  description: 'MSP documentation and credential platform',
  // A credential vault has no business in a search index or a link preview.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Every page is authenticated, tenant-scoped data, so nothing here may be
 * statically rendered or cached. `force-dynamic` at the root makes that the
 * default rather than something each page has to remember.
 */
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
