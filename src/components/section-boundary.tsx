'use client';

/**
 * One card failing instead of the whole page.
 *
 * The route-level boundary in src/app/(app)/error.tsx replaces the entire page
 * body when anything in it throws. That is the right floor, and it is a blunt
 * one: a technician who opened a client page to read a firewall password does
 * not care that the documents card is broken, and should not lose the
 * credentials because of it.
 *
 * So the sections that are most likely to break get their own boundary. A
 * throw inside becomes a small message where that card was, and every other
 * section on the page renders normally.
 *
 * A CLASS, because React has no hook form of this — getDerivedStateFromError
 * and componentDidCatch are the only way to catch a descendant's render error,
 * and that is still true in React 19.
 *
 * Client-side render errors only. A Server Component that throws while
 * fetching has already failed the segment before this exists, and a
 * serialisation failure is not caught by any boundary at all — see the note in
 * error.tsx.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

interface Props {
  /** Named in the fallback, so the message says which card is missing. */
  title: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class SectionBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[helm] the ${this.props.title} section failed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <Card className="h-full border-danger/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-danger" aria-hidden />
            {this.props.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-ink-muted">
            This section could not be displayed. Everything else on the page is unaffected.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ failed: false })}
            className="text-xs font-medium text-brand hover:underline"
          >
            Try again
          </button>
        </CardContent>
      </Card>
    );
  }
}
