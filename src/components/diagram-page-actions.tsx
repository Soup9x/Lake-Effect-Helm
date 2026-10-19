'use client';

/**
 * The diagram page's header buttons: Edit, and Archive or Restore.
 *
 * Edit is the same dialog + New opens in the Diagrams list. Delete is not here:
 * it is offered from the archive, in the list, after archiving — the order
 * everything else uses.
 */
import { useState } from 'react';
import { ArchiveRestore, Pencil, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { DiagramForm, type DiagramValues } from './diagram-form';
import { RowRemoveDialog } from './shell/row-remove-dialog';

export function DiagramPageActions({
  diagramId,
  organizationId,
  values,
  archived,
  sites,
  networks,
}: {
  diagramId: string;
  organizationId: string;
  values: DiagramValues;
  archived: boolean;
  sites: readonly { id: string; name: string }[];
  networks: readonly { id: string; name: string }[];
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

      {editing && (
        <DiagramForm
          organizationId={organizationId}
          diagram={{ id: diagramId, values }}
          sites={sites}
          networks={networks}
          open
          onOpenChange={setEditing}
        />
      )}
      {archiving && (
        <RowRemoveDialog
          rowId={diagramId}
          rowLabel={values.name}
          kind="diagram"
          mode={archived ? 'restore' : 'remove'}
          open
          onOpenChange={(next) => { if (!next) setArchiving(false); }}
        />
      )}
    </>
  );
}
