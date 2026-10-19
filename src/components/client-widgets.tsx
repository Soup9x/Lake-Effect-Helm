/**
 * The five cards at the top of a client's page.
 *
 * ALL FIVE READ DATA HELM ALREADY STORED. Nothing here needed a column, a
 * table or a tracking path — which was the whole brief for this group:
 *
 *   Credential strength     secret.current_strength_score, via v_secret_metadata
 *   Popular credentials     secret.access_count / last_accessed_at, both
 *                           incremented INSIDE helm.reveal_secret() immediately
 *                           after its helm.audit('secret.revealed') call. So
 *                           "popular" is derived from the audited path rather
 *                           than from a counter somebody could bump without
 *                           leaving a record.
 *   Recently updated        updated_at / updated_by, maintained by
 *                           helm.touch_updated_at() and the write routes
 *   Recently viewed by you  user_recent_view, filtered to this client
 *   Activity                audit_log, filtered to this client
 *
 * PRESENTATION ONLY, like src/components/widgets/index.tsx: every one takes
 * rows and renders them, none of them queries. Two of the five are derived from
 * rows the page had already fetched for the credentials list, so they cost no
 * query at all.
 *
 * Server components. They render text and links; there is no reason to ship
 * them to the browser.
 */
import Link from 'next/link';
import { Clock, Flame, History, PhoneCall, ScrollText, ShieldHalf } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { categoryBySource } from '@/lib/nav/org-categories';
import { formatDateTime, humanise } from '@/lib/ui/format';
import {
  STRENGTH_BUCKETS, STRENGTH_BUCKETS_UI, type StrengthBucket,
} from '@/lib/ui/strength';
import type { ClientActivityItem, UpdatedItem } from '@/lib/clients/activity';
import {
  importantContacts, REASON_LABEL, type ContactFlags,
} from '@/lib/contacts/important';
import type { RecentItem } from '@/lib/workspace/queries';
import { cn } from '@/lib/ui/cn';

/** Shared chrome, so five cards cannot drift into five layouts. */
function Widget({
  icon,
  title,
  children,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon} {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 text-sm">{children}</CardContent>
      {footer && (
        <div className="border-t border-border px-5 py-2 text-xs text-ink-faint">{footer}</div>
      )}
    </Card>
  );
}

/** One line of "nothing here", in the same voice everywhere. */
function Nothing({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-faint">{children}</p>;
}

// ---------------------------------------------------------------------------
// 1. Credential strength
// ---------------------------------------------------------------------------

/** Solid fills for the bar. Tokens, so dark mode follows without a second set. */
const BAR: Record<StrengthBucket, string> = {
  weak: 'bg-sev-warning',
  fair: 'bg-sev-notice',
  strong: 'bg-ok',
  unscored: 'bg-border-strong',
};

/**
 * How strong this client's stored passwords are, in four buckets.
 *
 * THE DENOMINATOR IS THE CREDENTIALS LIST ON THIS PAGE, not every secret the
 * client owns. v_secret_metadata also holds TOTP seeds and flexible-asset
 * secrets, so counting those would produce a total that disagrees with the
 * list directly below the card — and a widget whose number does not match the
 * thing beside it gets read as a bug, correctly.
 *
 * `withoutSecret` is credentials documented with no stored material at all: a
 * username and a URL and nothing to reveal. They are not weak and they are not
 * unscored, they are a different gap, so they are a footnote rather than a
 * fifth bar.
 */
export function CredentialStrengthWidget({
  counts,
  withoutSecret,
}: {
  counts: Record<StrengthBucket, number>;
  withoutSecret: number;
}) {
  const total = STRENGTH_BUCKETS.reduce((sum, key) => sum + counts[key], 0);

  return (
    <Widget
      icon={<ShieldHalf className="size-4 text-ink-faint" aria-hidden />}
      title="Credential strength"
      footer={
        withoutSecret > 0
          ? `${withoutSecret} credential${withoutSecret === 1 ? '' : 's'} documented with no stored secret.`
          : undefined
      }
    >
      {total === 0 ? (
        <Nothing>No stored credentials to score.</Nothing>
      ) : (
        <>
          {/* A bar, then the numbers. The bar is decorative — every segment it
              draws is stated as a figure below it, so nothing here is carried
              by colour alone. */}
          <div
            className="mb-3 flex h-2 overflow-hidden rounded-full bg-surface-sunken"
            aria-hidden
          >
            {STRENGTH_BUCKETS.filter((key) => counts[key] > 0).map((key) => (
              <div
                key={key}
                className={BAR[key]}
                style={{ width: `${(counts[key] / total) * 100}%` }}
              />
            ))}
          </div>
          <dl className="space-y-1">
            {STRENGTH_BUCKETS.map((key) => (
              <div key={key} className="flex items-center justify-between gap-2">
                <dt className="flex min-w-0 items-center gap-2">
                  <span className={cn('size-2 shrink-0 rounded-full', BAR[key])} aria-hidden />
                  <span
                    className={counts[key] > 0 ? 'text-ink-muted' : 'text-ink-faint'}
                    title={STRENGTH_BUCKETS_UI[key].hint}
                  >
                    {STRENGTH_BUCKETS_UI[key].label}
                  </span>
                </dt>
                <dd
                  className={cn(
                    'tabular-nums',
                    counts[key] > 0 ? 'font-medium text-ink' : 'text-ink-faint',
                  )}
                >
                  {counts[key]}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// 2. Popular credentials
// ---------------------------------------------------------------------------

export interface PopularCredential {
  nodeId: string;
  name: string;
  accessCount: number;
  lastAccessedAt: Date | null;
}

/**
 * The credentials this client's documentation is actually used for.
 *
 * Only rows that have been read at least once. A list padded out with zeros is
 * not a list of popular anything, and the empty state says something useful
 * instead.
 *
 * `canSeeAccessCounts` IS `secret:reveal`, and this card is the only place in
 * Helm that shows a read count. RLS does not gate these columns —
 * secret_rls_select admits any actor in the organisation's scope — so the
 * restriction is a product decision rather than a policy, and it is enforced
 * where the decision lives: the PAGE passes an empty array to an actor without
 * the permission, so no count is serialised into the RSC payload. This prop
 * exists only so the card can say which kind of empty it is, exactly as the
 * activity feed does. It is not the enforcement; do not make it the
 * enforcement.
 */
export function PopularCredentialsWidget({
  credentials,
  canSeeAccessCounts,
}: {
  credentials: PopularCredential[];
  canSeeAccessCounts: boolean;
}) {
  return (
    <Widget
      icon={<Flame className="size-4 text-ink-faint" aria-hidden />}
      title="Most used credentials"
    >
      {!canSeeAccessCounts ? (
        <Nothing>
          Reveal counts are shown to roles that can reveal a credential.
        </Nothing>
      ) : credentials.length === 0 ? (
        <Nothing>No credential here has been revealed yet.</Nothing>
      ) : (
        <ul className="space-y-1.5">
          {credentials.map((credential) => (
            <li key={credential.nodeId} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <Link
                  href={`/assets/${credential.nodeId}`}
                  className="truncate font-medium text-ink hover:text-brand"
                >
                  {credential.name}
                </Link>
                {credential.lastAccessedAt && (
                  <span className="block text-xs text-ink-faint">
                    last read {formatDateTime(credential.lastAccessedAt)}
                  </span>
                )}
              </span>
              <span
                className="shrink-0 tabular-nums text-xs text-ink-muted"
                title={`${credential.accessCount} recorded reveals`}
              >
                {credential.accessCount}×
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// 3. Recently viewed by you
// ---------------------------------------------------------------------------

export function ClientRecentlyViewedWidget({ items }: { items: readonly RecentItem[] }) {
  return (
    <Widget
      icon={<Clock className="size-4 text-ink-faint" aria-hidden />}
      title="You looked at"
    >
      {items.length === 0 ? (
        <Nothing>Items you open in this client appear here.</Nothing>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-3">
              <Link href={item.href} className="min-w-0 truncate text-ink hover:text-brand">
                {item.name}
              </Link>
              {item.context && (
                <span className="shrink-0 text-xs text-ink-faint">
                  {categoryBySource(item.context)?.label ?? humanise(item.context)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// 4. Recently updated
// ---------------------------------------------------------------------------

/**
 * Where a row sends a reader.
 *
 * An asset has its own page. The three that do not — sites, contacts,
 * documents — have a category listing under the client, which is where they are
 * read and edited. Anything with no category at all (a flexible asset, whose
 * types the sidebar lists individually) still has an asset page.
 */
function hrefFor(item: UpdatedItem, organizationId: string): string {
  const category = categoryBySource(item.source);
  if (category && category.kind === 'table') {
    return `/organizations/${organizationId}/${category.slug}`;
  }
  return `/assets/${item.id}`;
}

export function RecentlyUpdatedWidget({
  items,
  organizationId,
}: {
  items: readonly UpdatedItem[];
  organizationId: string;
}) {
  return (
    <Widget
      icon={<History className="size-4 text-ink-faint" aria-hidden />}
      title="Recently updated"
      footer="Field edits. Reveals, rotations and exports are in Activity."
    >
      {items.length === 0 ? (
        <Nothing>Nothing is documented for this client yet.</Nothing>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={`${item.source}-${item.id}`} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <Link
                  href={hrefFor(item, organizationId)}
                  className="truncate font-medium text-ink hover:text-brand"
                >
                  {item.name}
                </Link>
                <span className="block text-xs text-ink-faint">
                  {categoryBySource(item.source)?.label ?? humanise(item.source)}
                  {/* No name where no write path recorded one — a row created by
                      an import or never edited since. Inventing "System" here
                      would be a claim about who did it. */}
                  {item.by && ` · ${item.by}`}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                {formatDateTime(item.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// 5. Activity
// ---------------------------------------------------------------------------

/**
 * This client's slice of the audit log.
 *
 * `canReadAudit` IS WHY THIS PROP EXISTS. The audit_log policy requires
 * `helm.has_permission('audit:read')`, so an actor without it gets zero rows
 * from a query that succeeded — indistinguishable, here, from a client nothing
 * has happened to. Telling somebody "nothing recorded yet" about a log they are
 * not allowed to read is a lie that also wastes their afternoon, so the caller
 * passes what the session says and this renders the honest sentence.
 */
export function ActivityFeedWidget({
  activity,
  canReadAudit,
}: {
  activity: readonly ClientActivityItem[];
  canReadAudit: boolean;
}) {
  return (
    <Widget
      icon={<ScrollText className="size-4 text-ink-faint" aria-hidden />}
      title="Activity"
      footer={
        canReadAudit ? (
          <Link href="/audit" className="text-brand hover:underline">
            The whole audit trail
          </Link>
        ) : undefined
      }
    >
      {!canReadAudit ? (
        <Nothing>Your role does not include reading the audit log.</Nothing>
      ) : activity.length === 0 ? (
        <Nothing>No audited events for this client yet.</Nothing>
      ) : (
        <ul className="space-y-1.5">
          {activity.map((event) => (
            <li key={event.eventUid} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="text-ink">{event.actorLabel}</span>{' '}
                <span className="font-mono text-xs text-ink-muted">{event.action}</span>
                {/* Denials are the rows worth reading, as on the dashboard. */}
                {event.outcome !== 'success' && (
                  <Badge
                    tone={event.outcome === 'denied' ? 'warning' : 'danger'}
                    className="ml-1.5"
                  >
                    {event.outcome}
                  </Badge>
                )}
                {event.reason && (
                  <span className="block truncate text-xs text-ink-faint" title={event.reason}>
                    {event.reason}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                {formatDateTime(event.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// 6. Important contacts — group L
// ---------------------------------------------------------------------------

export interface ImportantContact extends ContactFlags {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Who to call, out of the flags the contact table already carries.
 *
 * NEAR THE TOP OF THE CLIENT PAGE, not in the contacts section further down,
 * because that is the difference this widget makes: the full table has always
 * been there and already badges Primary and Emergency, but it is below the
 * assets and somebody on a call has to scroll past them to find a phone number.
 *
 * THE PHONE NUMBER IS THE PAYLOAD, so it is a `tel:` link and it is not
 * truncated. An email address is secondary here — if email would do, this is
 * not the moment this card is for.
 *
 * SAYS WHICH EMPTY IT IS. A client with contacts but no flags set is a
 * different thing from a client with no contacts, and the first one has an
 * action: go and tick the boxes. Decision 35 is why there is nothing to tick
 * CALLED "important" — the flags are the ones that already existed.
 */
export function ImportantContactsWidget({
  contacts,
  totalContacts,
  organizationId,
}: {
  contacts: readonly ImportantContact[];
  totalContacts: number;
  organizationId: string;
}) {
  const ranked = importantContacts(contacts);

  return (
    <Widget
      icon={<PhoneCall className="size-4 text-ink-faint" aria-hidden />}
      title="Who to call"
      footer={
        totalContacts > ranked.length ? (
          <Link
            href={`/organizations/${organizationId}/contacts`}
            className="text-ink-muted hover:text-ink"
          >
            All {totalContacts} contacts
          </Link>
        ) : undefined
      }
    >
      {ranked.length === 0 ? (
        <Nothing>
          {totalContacts === 0
            ? 'No contacts documented for this client.'
            : 'No contact is marked primary, emergency, authorised or technical.'}
        </Nothing>
      ) : (
        <ul className="space-y-2">
          {ranked.map(({ contact, reason }) => (
            <li key={contact.id} className="space-y-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Link href={`/contacts/${contact.id}`} className="text-ink hover:underline">
                  {contact.name}
                </Link>
                <Badge tone={reason === 'emergency' ? 'critical' : 'neutral'}>
                  {REASON_LABEL[reason]}
                </Badge>
                {contact.title && (
                  <span className="text-xs text-ink-faint">{contact.title}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs">
                {contact.phone ? (
                  <a href={`tel:${contact.phone}`} className="text-brand hover:underline">
                    {contact.phone}
                  </a>
                ) : (
                  <span className="text-ink-faint">no number recorded</span>
                )}
                {contact.email && (
                  <a
                    href={`mailto:${contact.email}`}
                    className="truncate text-ink-muted hover:text-ink"
                  >
                    {contact.email}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
