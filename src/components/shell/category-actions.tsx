'use client';

/**
 * The two buttons in a category's header, and what they open.
 *
 * ONE COMPONENT RATHER THAN A BRANCH IN THE PAGE, because the page is a server
 * component and every one of these forms is a client one. Routing the choice
 * through here keeps the page server-rendered and puts the "what does + New mean
 * on this screen" decision in a single readable switch.
 *
 * A BUTTON THAT CANNOT WORK IS NOT RENDERED DISABLED, it is explained. Documents
 * are files, not rows, so Import is absent on that category rather than greyed;
 * SOPs cannot be created through the API at all, so + New is absent there. A
 * disabled control invites somebody to work out what is wrong with their
 * permissions when the answer is that the thing does not exist.
 */
import { useState } from 'react';
import { ImportDialog } from './import-dialog';
import { NewContactForm } from './new-contact-form';
import { NewAssetForm } from '../new-asset-form';
import { NewSecretForm } from '../new-secret-form';
import { SiteForm } from '../site-form';
import { Button } from '../ui/button';

export interface CategoryActionsProps {
  organizationId: string;
  /** The category slug — 'passwords', 'contacts', 'configurations', … */
  category: string;
  categoryLabel: string;
  /** The node_type to pin a new asset to, when this category is an asset kind. */
  nodeType?: string | undefined;
  /** Null where this category cannot be imported from a file. */
  importSpec?: { templateHeader: string; hint: string } | undefined;
  /** Sites for the asset form's picker. */
  sites: readonly { id: string; name: string }[];
  /** Whether + New can do anything here. */
  canCreate: boolean;
}

export function CategoryActions({
  organizationId,
  category,
  categoryLabel,
  nodeType,
  importSpec,
  sites,
  canCreate,
}: CategoryActionsProps) {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  return (
    <>
      {importSpec && (
        <Button variant="action" size="sm" onClick={() => setImporting(true)}>
          Import
        </Button>
      )}
      {canCreate && (
        <Button variant="cta" size="sm" onClick={() => setCreating(true)}>
          + New
        </Button>
      )}

      {importSpec && (
        <ImportDialog
          organizationId={organizationId}
          category={category}
          categoryLabel={categoryLabel}
          templateHeader={importSpec.templateHeader}
          hint={importSpec.hint}
          open={importing}
          onOpenChange={setImporting}
        />
      )}

      {/*
        Each form is mounted only while it is open. They hold draft state —
        including, on the password form, a plaintext value — and keeping four of
        them mounted behind a closed dialog would mean three forms holding
        half-typed input nobody can see.
      */}
      {creating && category === 'contacts' && (
        <NewContactForm
          organizationId={organizationId}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
      {creating && category === 'passwords' && (
        <NewSecretForm
          organizationId={organizationId}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
      {creating && category === 'locations' && (
        <SiteForm
          organizationId={organizationId}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
      {creating && nodeType && (
        <NewAssetForm
          organizationId={organizationId}
          sites={[...sites]}
          lockedNodeType={nodeType}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
    </>
  );
}
