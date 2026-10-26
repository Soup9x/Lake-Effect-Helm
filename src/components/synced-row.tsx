/**
 * "NinjaOne · Synced <time>" as a row of a Details list, the way an asset's
 * Details card says which integration keeps it current. Optionally with a
 * link to the record in the other system.
 */
import { Cloud, ExternalLink } from 'lucide-react';

export function SyncedRow({ source, at, href }: { source: string; at: string; href?: string | null }) {
  return (
    <>
      <dt className="truncate text-ink-muted">{source}</dt>
      <dd className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink" title={`Kept current by the ${source} sync`}>
        <span className="flex items-center gap-1.5">
          <Cloud className="size-3.5 text-ink-faint" aria-hidden />
          Synced {at}
        </span>
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
            Open in {source} <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </dd>
    </>
  );
}
