/**
 * What changed on this entry, by whom and when (0970). Newest first; the
 * first ten shown, the rest one click away.
 */
import { History } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { formatDateTime } from '@/lib/ui/format';
import type { HistoryEntry } from '@/lib/history/queries';

const VERB: Record<HistoryEntry['kind'], string> = {
  created: 'created this',
  updated: 'changed',
  archived: 'archived this',
  restored: 'restored this',
};

function Entry({ entry }: { entry: HistoryEntry }) {
  return (
    <li className="space-y-1 border-l-2 border-border pl-3">
      <p className="text-sm text-ink">
        <span className="font-medium">{entry.actor}</span>{' '}
        {entry.kind === 'updated' && entry.changes.length === 0 ? 'saved this' : VERB[entry.kind]}
        <span className="ml-2 text-xs text-ink-faint">{formatDateTime(entry.changedAt)}</span>
      </p>
      {entry.changes.length > 0 && (
        <ul className="space-y-0.5 text-xs text-ink-muted">
          {entry.changes.map((c) => (
            <li key={c.field} className="break-words">
              <span className="text-ink">{c.label}</span>
              {': '}
              <span className="line-through decoration-ink-faint">{c.before ?? 'empty'}</span>
              {' → '}
              <span className="text-ink">{c.after ?? 'empty'}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function HistoryCard({ entries }: { entries: readonly HistoryEntry[] }) {
  const first = entries.slice(0, 10);
  const rest = entries.slice(10);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-ink-faint" aria-hidden /> History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-ink-faint">No changes recorded yet. Edits from now on appear here.</p>
        ) : (
          <>
            <ul className="space-y-3">{first.map((e) => <Entry key={e.id} entry={e} />)}</ul>
            {rest.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">
                  {rest.length} earlier {rest.length === 1 ? 'change' : 'changes'}
                </summary>
                <ul className="mt-3 space-y-3">{rest.map((e) => <Entry key={e.id} entry={e} />)}</ul>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
