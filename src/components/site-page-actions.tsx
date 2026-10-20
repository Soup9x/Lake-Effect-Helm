'use client';

/**
 * The location page's header buttons: Edit, and Archive or Restore.
 *
 * Edit is the same dialog the Locations list opens, so a correction made from
 * either place goes through one form. Delete is not here: it is offered from
 * the archive, in the list, after archiving — the order contacts use (0940).
 */
import { useState } from 'react';
import { ArchiveRestore, Pencil, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { SiteForm } from './site-form';
import { RowRemoveDialog } from './shell/row-remove-dialog';
import type { SiteValues } from '@/lib/sites/values';

export function SitePageActions({
  siteId,
  organizationId,
  values,
  archived,
}: {
  siteId: string;
  organizationId: string;
  values: SiteValues;
  archived: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
        <Pencil aria-hidden /> Edit
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setArchiving(true)}>
        {archived ? <ArchiveRestore aria-hidden /> : <Trash2 aria-hidden />}
        {archived ? 'Restore' : 'Archive'}
      </Button>

      <SiteForm
        organizationId={organizationId}
        site={{ id: siteId, values }}
        open={editing}
        onOpenChange={setEditing}
      />
      {archiving && (
        <RowRemoveDialog
          rowId={siteId}
          rowLabel={values.name}
          kind="site"
          mode={archived ? 'restore' : 'remove'}
          open
          onOpenChange={(next) => { if (!next) setArchiving(false); }}
        />
      )}
    </>
  );
}
