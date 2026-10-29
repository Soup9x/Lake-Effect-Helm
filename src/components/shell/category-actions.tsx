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
 * are files, not rows, so Import is absent on that category rather than greyed.
 * A disabled control invites somebody to work out what is wrong with their
 * permissions when the answer is that the thing does not exist.
 *
 * SOPs USED TO BE THAT CASE and are no longer. + New was absent on that
 * category because nothing could create one — POST /api/assets excludes `sop`
 * on purpose, since a procedure's payload is its steps. F1 added POST /api/sops
 * and NewProcedureForm, so the button now does something.
 *
 * WHICH FORM IS NOT DECIDED HERE. createFormFor() in src/lib/nav/org-categories
 * returns exactly one, and the reason is SOPs: the generic asset form's
 * condition was "this category has a node_type", which is true of a procedure
 * too, so two forms opened at once unless a guard said otherwise. A single
 * answer makes that impossible instead of guarded, and it can be tested without
 * a DOM.
 */
import { useState } from 'react';
import { ImportDialog } from './import-dialog';
import { PasswordImportDialog } from './password-import-dialog';
import { ContactForm } from './contact-form';
import { NewProcedureForm } from '../new-procedure-form';
import { NewAssetForm } from '../new-asset-form';
import { ConfigurationForm } from '../configuration-form';
import { NewSecretForm } from '../new-secret-form';
import { SiteForm } from '../site-form';
import { DiagramForm } from '../diagram-form';
import { Button } from '../ui/button';
import { createFormFor } from '@/lib/nav/org-categories';

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
  /** For the configuration form (0800): the client's people, and what an interface can connect to. */
  contacts?: readonly { id: string; name: string }[] | undefined;
  connectable?: readonly { id: string; name: string }[] | undefined;
  /** For the diagram form (0880): the client's network entries. */
  networks?: readonly { id: string; name: string }[] | undefined;
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
  contacts = [],
  connectable = [],
  networks = [],
  canCreate,
}: CategoryActionsProps) {
  const form = createFormFor(category, nodeType);
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

      {/* A password manager's export needs its columns checked; Helm's own templates do not. */}
      {importSpec && category === 'passwords' && (
        <PasswordImportDialog
          organizationId={organizationId}
          templateHeader={importSpec.templateHeader}
          open={importing}
          onOpenChange={setImporting}
        />
      )}
      {importSpec && category !== 'passwords' && (
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
      {creating && form === 'contact' && (
        <ContactForm
          organizationId={organizationId}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
      {creating && form === 'secret' && (
        <NewSecretForm
          organizationId={organizationId}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
      {creating && form === 'site' && (
        <SiteForm
          organizationId={organizationId}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
      {creating && form === 'diagram' && (
        <DiagramForm
          organizationId={organizationId}
          sites={sites}
          networks={networks}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
      {creating && form === 'procedure' && (
        <NewProcedureForm
          organizationId={organizationId}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
      {creating && form === 'configuration' && (
        <ConfigurationForm
          organizationId={organizationId}
          open={creating}
          onOpenChange={setCreating}
          sites={sites}
          contacts={contacts}
          connectable={connectable}
        />
      )}
      {creating && form === 'asset' && nodeType && (
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
