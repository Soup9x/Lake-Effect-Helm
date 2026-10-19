'use client';

/**
 * The location page's header buttons: Edit, and Remove.
 *
 * Edit is the same dialog the Locations list opens, so a correction made from
 * either place goes through one form. Remove is the list's Remove too; the only
 * difference is where it leaves you — a removed location has no page, so this
 * one goes back to the client's Locations.
 */
import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { SiteForm } from './site-form';
import { RowRemoveDialog } from './shell/row-remove-dialog';
import type { SiteValues } from '@/lib/sites/values';

export function SitePageActions({
  siteId,
  organizationId,
  values,
}: {
  siteId: string;
  organizationId: string;
  values: SiteValues;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
        <Pencil aria-hidden /> Edit
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
        <Trash2 aria-hidden /> Remove
      </Button>

      <SiteForm
        organizationId={organizationId}
        site={{ id: siteId, values }}
        open={editing}
        onOpenChange={setEditing}
      />
      {removing && (
        <RowRemoveDialog
          rowId={siteId}
          rowLabel={values.name}
          kind="site"
          open
          onOpenChange={(next) => { if (!next) setRemoving(false); }}
          afterHref={`/organizations/${organizationId}/locations`}
        />
      )}
    </>
  );
}
