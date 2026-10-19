'use client';

/**
 * The contact page's header buttons: Edit, and Archive or Restore.
 *
 * Edit is the same dialog the Contacts list opens, so a correction made from
 * either place goes through one form. Delete is not here: it is offered from
 * the archive, in the list, after archiving — the order everything else uses.
 */
import { useState } from 'react';
import { ArchiveRestore, Pencil, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { ContactForm } from './shell/contact-form';
import { RowRemoveDialog } from './shell/row-remove-dialog';

export function ContactPageActions({
  contactId,
  organizationId,
  name,
  archived,
}: {
  contactId: string;
  organizationId: string;
  name: string;
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

      <ContactForm
        organizationId={organizationId}
        contactId={contactId}
        open={editing}
        onOpenChange={setEditing}
      />
      {archiving && (
        <RowRemoveDialog
          rowId={contactId}
          rowLabel={name}
          kind="contact"
          mode={archived ? 'restore' : 'remove'}
          open
          onOpenChange={(next) => { if (!next) setArchiving(false); }}
        />
      )}
    </>
  );
}
