'use client';

/**
 * Uploading, replacing and removing a client's logo.
 *
 * A CLIENT COMPONENT because it reads a File off an <input type="file"> and
 * posts multipart/form-data, neither of which a server component can do. It is
 * the only part of group I that ships JavaScript.
 *
 * THE PREVIEW IS THE STORED IMAGE, NOT A LOCAL OBJECT URL. A FileReader
 * preview shows what the browser read, which is not necessarily what the server
 * accepted — it sniffs the bytes and may store a different content type than
 * the browser claimed, and it refuses anything that is not one of four raster
 * formats. Showing the browser's copy would mean a refused upload could still
 * appear to have worked. So the upload completes, the route revalidates, and
 * the image on screen is the one being served from the database.
 *
 * WHICH MEANS THE CACHE HAS TO BE DEFEATED exactly once. The logo is served
 * under an ETag at a URL that does not change when the bytes do, so after a
 * replacement the browser would revalidate and, finding a new ETag, fetch the
 * new bytes — correct, but only if it revalidates. `?v=<n>` after a successful
 * upload makes the new request unambiguous rather than relying on
 * must-revalidate being honoured by every browser in every state.
 *
 * NO DRAG AND DROP. It is one button that sets one image, and a drop target
 * that is also a button is two affordances for one action.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageUp, Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { ClientAvatar } from './client-avatar';
import { LOGO_CONTENT_TYPES, MAX_LOGO_BYTES } from '@/lib/logos/limits';

export function LogoControl({
  organizationId,
  name,
  /** What the avatar should show now; see src/lib/ui/logo.ts for precedence. */
  src,
  canWrite,
}: {
  organizationId: string;
  name: string;
  src: string | null;
  canWrite: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a write so the <img> cannot serve a cached copy of the old
  // bytes from a URL that did not change.
  const [version, setVersion] = useState(0);

  const shown = src && version > 0 ? `${src}?v=${version}` : src;

  async function upload(file: File) {
    setError(null);

    // Checked here as well as on the server, because the server's answer costs
    // an upload of the whole file first. Neither is the boundary; the route and
    // a CHECK constraint are.
    if (file.size > MAX_LOGO_BYTES) {
      setError(`That file is ${Math.round(file.size / 1024)} KB. The limit is `
        + `${Math.floor(MAX_LOGO_BYTES / 1024)} KB.`);
      return;
    }

    setBusy('upload');
    try {
      const body = new FormData();
      body.set('file', file);
      const response = await fetch(`/api/organizations/${organizationId}/logo`, {
        method: 'POST',
        body,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(messageFrom(payload) ?? 'The logo could not be stored.');
        return;
      }
      setVersion((n) => n + 1);
      router.refresh();
    } catch {
      setError('The logo could not be stored.');
    } finally {
      setBusy(null);
      // So choosing the same file twice in a row fires a change event again.
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setError(null);
    setBusy('remove');
    try {
      const response = await fetch(`/api/organizations/${organizationId}/logo`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(messageFrom(payload) ?? 'The logo could not be removed.');
        return;
      }
      setVersion((n) => n + 1);
      router.refresh();
    } catch {
      setError('The logo could not be removed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <ClientAvatar name={name} logoUrl={shown} size="lg" />
        {canWrite && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                ref={input}
                type="file"
                className="hidden"
                accept={LOGO_CONTENT_TYPES.join(',')}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy !== null}
                onClick={() => input.current?.click()}
              >
                {busy === 'upload' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <ImageUp className="size-4" aria-hidden />
                )}
                {src ? 'Replace logo' : 'Upload logo'}
              </Button>
              {src && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void remove()}
                >
                  {busy === 'remove' ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="size-4" aria-hidden />
                  )}
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-ink-faint">
              PNG, JPEG, WebP or GIF, up to {Math.floor(MAX_LOGO_BYTES / 1024)} KB. An
              SVG cannot be used: served from this address it could run script with
              your session.
            </p>
          </div>
        )}
      </div>
      {error && (
        <p className="rounded-md bg-sev-warning/10 px-2 py-1.5 text-sm text-ink">{error}</p>
      )}
    </div>
  );
}

/** The route's own message, which names the field and the reason. */
function messageFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : null;
}
