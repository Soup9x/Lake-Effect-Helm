'use client';

/** The Edit button on a device's page, opening the sectioned configuration form. */
import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { ConfigurationForm } from './configuration-form';

export function ConfigurationEdit(props: {
  deviceId: string;
  organizationId: string;
  sites: readonly { id: string; name: string }[];
  contacts: readonly { id: string; name: string }[];
  connectable: readonly { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <SlidersHorizontal className="size-3.5" aria-hidden />
        Edit configuration
      </Button>
      {open && <ConfigurationForm {...props} open={open} onOpenChange={setOpen} />}
    </>
  );
}
