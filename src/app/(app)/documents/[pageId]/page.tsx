import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { DocumentPage } from '@/components/document-page';
import { readPage } from '@/lib/documents/pages';
import { listPageAttachments } from '@/lib/clients/queries';
import { maxUploadBytes } from '@/lib/documents/limits';
import { isClientRole } from '@/lib/ui/roles';
import type { DocumentRow } from '@/lib/ui/documents';
import type { JSONContent } from '@tiptap/react';

export const dynamic = 'force-dynamic';

/** A written document (0810), under the client that owns it. */
export default async function DocumentPageRoute({ params }: { params: Promise<{ pageId: string }> }) {
  const identity = await getServerIdentity();
  const { pageId } = await params;
  if (!isUuid(pageId)) notFound();

  const data = await withTenant(actorOf(identity), async (tx, session) => {
    const page = await readPage(tx, pageId);
    if (!page) return null;
    const [org] = await tx<{ name: string }[]>`SELECT name FROM organization WHERE id = ${page.organizationId}::uuid`;
    const path = await tx<{ path: string[] }[]>`SELECT helm.document_folder_path(${page.folderId}::uuid) AS path`;
    return {
      page,
      organizationName: org?.name ?? 'Client',
      folderPath: path[0]?.path ?? [],
      attachments: await listPageAttachments(tx, pageId),
      canDelete: session.permissions.includes('asset:delete'),
    };
  });
  if (!data) notFound();
  const { page, organizationName, folderPath, attachments, canDelete } = data;
  const canWrite = !isClientRole(identity.roleKey);

  const rows: DocumentRow[] = attachments.map((d) => ({
    id: d.id, folderId: d.folder_id, filename: d.filename, contentType: d.content_type,
    byteSize: Number(d.byte_size), isInternalOnly: d.is_internal_only, archived: d.archived_at !== null,
    uploadedAt: d.uploaded_at.toISOString(), uploadedBy: d.uploaded_by_name,
  }));

  return (
    <>
      <PageHeader
        title={page.title}
        description={folderPath.length > 0 ? folderPath.join(' / ') : undefined}
        trail={[
          { label: 'Clients', href: '/organizations' },
          { label: organizationName, href: `/organizations/${page.organizationId}` },
          { label: 'Documents', href: `/organizations/${page.organizationId}/documents` },
        ]}
      />
      <PageBody>
        <DocumentPage
          page={{ ...page, body: page.body as JSONContent }}
          attachments={rows}
          canWrite={canWrite}
          canDelete={canDelete}
          maxBytes={maxUploadBytes()}
        />
      </PageBody>
    </>
  );
}
