/**
 * The two rows of avatars above the clients table: what you opened, what you
 * starred.
 *
 * WHY BOTH, WHEN THE TABLE ALREADY SORTS STARRED CLIENTS FIRST. They answer
 * different questions. Favourites is "the six clients I own", which is stable
 * for months. Recents is "the client I was in before lunch", which is stable
 * for an hour and is the one that actually saves a search. A technician
 * carrying four tickets does not want to read a table to resume one of them.
 *
 * RECENTS IS CLIENTS ONLY, filtered from a list that also holds assets. The
 * header dropdown (feature #1) is the place for mixed types with type icons;
 * a row of client avatars that silently included a firewall would be lying
 * about what the row is.
 *
 * Server component. It renders links and initials, so there is no reason to
 * ship it to the browser.
 */
import Link from 'next/link';
import { Clock, Star } from 'lucide-react';
import { ClientAvatar } from './client-avatar';
import type { FavoriteClient, RecentItem } from '@/lib/workspace/queries';

/** Rows of this many, which is the point where the strip stops being scannable. */
const RECENT_LIMIT = 8;

function Strip({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-faint">
        {icon}
        {label}
      </span>
      {/* Scrolls rather than wraps: a strip that becomes three rows pushes the
          table off the screen, which is the thing people came for. */}
      <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-1">{children}</div>
    </div>
  );
}

function Tile({
  href,
  name,
  logoUrl,
}: {
  href: string;
  name: string;
  logoUrl: string | null | undefined;
}) {
  return (
    <Link
      href={href}
      title={name}
      className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink-muted transition-colors hover:border-brand hover:text-brand"
    >
      <ClientAvatar name={name} logoUrl={logoUrl} size="sm" />
      {/* Truncated, not abbreviated: "Northwind Managed Serv…" is readable and
          an initials-only tile is a guessing game. */}
      <span className="max-w-[10rem] truncate">{name}</span>
    </Link>
  );
}

export function ClientStrip({
  recents,
  favorites,
  logos,
}: {
  recents: readonly RecentItem[];
  favorites: readonly FavoriteClient[];
  /** organizationId → logo_url, so neither query has to carry the column. */
  logos: ReadonlyMap<string, string | null>;
}) {
  const recentClients = recents.filter((item) => item.kind === 'client').slice(0, RECENT_LIMIT);

  // Nothing to show on a first visit, and an empty strip with two labels is
  // worse than no strip: it reserves space to say nothing.
  if (recentClients.length === 0 && favorites.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3">
      {recentClients.length > 0 && (
        <Strip icon={<Clock className="size-3.5" aria-hidden />} label="Recent">
          {recentClients.map((item) => (
            <Tile
              key={item.id}
              href={item.href}
              name={item.name}
              logoUrl={logos.get(item.id)}
            />
          ))}
        </Strip>
      )}
      {favorites.length > 0 && (
        <Strip icon={<Star className="size-3.5" aria-hidden />} label="Starred">
          {favorites.map((favorite) => (
            <Tile
              key={favorite.organizationId}
              href={`/organizations/${favorite.organizationId}`}
              name={favorite.name}
              logoUrl={logos.get(favorite.organizationId)}
            />
          ))}
        </Strip>
      )}
    </div>
  );
}
