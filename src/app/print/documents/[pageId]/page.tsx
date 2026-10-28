import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { readPage } from '@/lib/documents/pages';
import { listDependencies } from '@/lib/documents/links';
import { listPageAttachments } from '@/lib/clients/queries';
import { DocumentEditor } from '@/components/document-editor';
import { PrintTrigger } from '@/components/print-trigger';
import { formatBytes } from '@/lib/ui/documents';
import { formatDateTime } from '@/lib/ui/format';
import type { JSONContent } from '@tiptap/react';

export const dynamic = 'force-dynamic';

async function load(pageId: string) {
  const identity = await getServerIdentity();
  return withTenant(actorOf(identity), async (tx) => {
    const page = await readPage(tx, pageId);
    if (!page) return null;
    const [org] = await tx<{ name: string }[]>`SELECT name FROM organization WHERE id = ${page.organizationId}::uuid`;
    const path = await tx<{ path: string[] }[]>`SELECT helm.document_folder_path(${page.folderId}::uuid) AS path`;
    return {
      page,
      organizationName: org?.name ?? 'Client',
      folderPath: path[0]?.path ?? [],
      attachments: (await listPageAttachments(tx, pageId)).filter((a) => a.archived_at === null),
      dependencies: (await listDependencies(tx, pageId)).filter((d) => !d.archived),
    };
  });
}

/** The tab title is the PDF's default file name, so it is the document's title. */
export async function generateMetadata({ params }: { params: Promise<{ pageId: string }> }): Promise<Metadata> {
  const { pageId } = await params;
  if (!isUuid(pageId)) return {};
  const data = await load(pageId);
  return data ? { title: data.page.title } : {};
}

/** A written document (0810) for printing or saving as a PDF: the body, and what it depends on. */
export default async function PrintDocumentRoute({ params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  if (!isUuid(pageId)) notFound();
  const data = await load(pageId);
  if (!data) notFound();
  const { page, organizationName, folderPath, attachments, dependencies } = data;

  return (
    <main className="mx-auto max-w-3xl px-6 py-8 print:max-w-none print:p-0">
      <PrintTrigger backHref={`/documents/${page.id}`} />
      <header className="mb-6 border-b border-border pb-4">
        <p className="text-xs uppercase tracking-wide text-ink-faint">
          {[organizationName, ...folderPath].join(' / ')}
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-ink">{page.title}</h1>
        <p className="mt-1 text-xs text-ink-faint">
          Version {page.version} · Last saved {formatDateTime(page.updatedAt)}{page.updatedBy && ` by ${page.updatedBy}`}
          {page.isInternalOnly && ' · Internal'}
        </p>
      </header>

      <DocumentEditor content={page.body as JSONContent} editable={false} />

      {dependencies.length > 0 && (
        <section className="mt-8 break-inside-avoid border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-ink">Dependencies</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {dependencies.map((d) => (
              <li key={d.id}>
                <span className="text-ink">{d.title}</span>
                <span className="text-ink-faint"> · {d.label}{d.note && ` · ${d.note}`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {attachments.length > 0 && (
        <section className="mt-6 break-inside-avoid border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-ink">Attachments</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {attachments.map((a) => (
              <li key={a.id}>
                <span className="text-ink">{a.filename}</span>
                <span className="text-ink-faint"> · {formatBytes(Number(a.byte_size))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
