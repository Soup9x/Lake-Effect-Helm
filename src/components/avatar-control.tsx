'use client';

/**
 * Setting, replacing and removing your own profile picture (1040).
 *
 * The logo control's pattern: the preview is the stored image as the server
 * serves it, never the browser's local copy, so a refused upload cannot look
 * as though it worked. The URL carries the picture's hash, so after a change
 * the refreshed page asks for the new bytes rather than a cached old copy.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageUp, Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { UserAvatar } from './user-avatar';
import { LOGO_CONTENT_TYPES, MAX_LOGO_BYTES } from '@/lib/logos/limits';
import { apiFetch } from '@/lib/ui/api';

export function AvatarControl({ name, src }: { name: string; src: string | null }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_LOGO_BYTES) {
      setError(`That file is ${Math.round(file.size / 1024)} KB. The limit is ${Math.floor(MAX_LOGO_BYTES / 1024)} KB.`);
      return;
    }
    setBusy('upload');
    try {
      const body = new FormData();
      body.set('file', file);
      const result = await apiFetch('/api/account/avatar', { method: 'POST', body });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setError(null);
    setBusy('remove');
    try {
      const result = await apiFetch('/api/account/avatar', { method: 'DELETE' });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4">
        <UserAvatar name={name} src={src} size="lg" />
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
            <Button type="button" variant="secondary" size="sm" disabled={busy !== null}
                    onClick={() => input.current?.click()}>
              {busy === 'upload' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ImageUp className="size-4" aria-hidden />}
              {src ? 'Change picture' : 'Upload a picture'}
            </Button>
            {src && (
              <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void remove()}>
                {busy === 'remove' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-faint">
            PNG, JPEG, WebP or GIF, up to {Math.floor(MAX_LOGO_BYTES / 1024)} KB. Shown beside your name to
            everybody in this workspace. A square image looks best.
          </p>
        </div>
      </div>
      {error && <p role="alert" className="rounded-md bg-sev-warning/10 px-2 py-1.5 text-sm text-ink">{error}</p>}
    </div>
  );
}
