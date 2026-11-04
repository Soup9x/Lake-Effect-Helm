'use client';

/**
 * The "confirm it is you" fields shared by every prompt that used to take only
 * the Helm password (1270): the password box, a "Confirm with Microsoft 365"
 * button when the person's account is linked to a sign-in provider, and the
 * authenticator code when one is needed.
 *
 * Who sees what:
 *
 *   password, no provider     the password box, as before
 *   provider, no password     the provider button; a quiet "use a password
 *                             instead" link covers a directory (RADIUS) login
 *   both                      the provider button, then "or", then the box
 *
 * The provider button opens the provider's sign-in in a small window and hands
 * the caller a ticket when it lands. The caller sends `ssoTicket` where it used
 * to send `password` (see reauthCredentials()).
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import {
  confirmWithSso,
  describeSsoOutcome,
  loadReauthOptions,
  type ReauthOptions,
} from '@/lib/ui/sso-reauth';

/** Load how this person can confirm, once `active` turns true. */
export function useReauthOptions(active: boolean): ReauthOptions | null {
  const [options, setOptions] = useState<ReauthOptions | null>(null);
  useEffect(() => {
    if (!active || options) return;
    let live = true;
    void loadReauthOptions().then((loaded) => {
      if (live && loaded) setOptions(loaded);
    });
    return () => {
      live = false;
    };
  }, [active, options]);
  return options;
}

/** The body fields for whichever way the person confirmed. */
export function reauthCredentials(input: {
  password: string;
  ticket: string | null;
  code: string;
  askCode: boolean;
}): { password: string } | { ssoTicket: string } | ({ password: string } | { ssoTicket: string }) & { code: string } {
  const base = input.ticket ? { ssoTicket: input.ticket } : { password: input.password };
  return input.askCode && input.code.trim() ? { ...base, code: input.code.trim() } : base;
}

/**
 * After a refusal, is the provider confirmation still good? Only when the
 * server stopped to ask for the authenticator code before spending it; any
 * other refusal (expired, already used, wrong code) means confirming again.
 */
export function ticketSurvives(details: Record<string, unknown> | undefined): boolean {
  return details?.secondFactor === 'totp' && !details?.ssoSpent;
}

/** The provider button on its own, for the step-up prompt and the forms below. */
export function SsoConfirmButton({
  name,
  onConfirmed,
  onError,
  disabled,
  className,
}: {
  name: string;
  onConfirmed: (ticket: string) => void;
  onError: (message: string) => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  const [waiting, setWaiting] = useState(false);

  const click = () => {
    // No await before confirmWithSso(): the window must open inside the click.
    setWaiting(true);
    void confirmWithSso().then((outcome) => {
      setWaiting(false);
      if (outcome.kind === 'ok') onConfirmed(outcome.ticket);
      else {
        const message = describeSsoOutcome(outcome, name);
        if (message) onError(message);
      }
    });
  };

  return (
    <Button
      type="button"
      variant="primary"
      className={className ?? 'w-full'}
      onClick={click}
      disabled={disabled || waiting}
    >
      {waiting ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
      {waiting ? `Waiting for ${name}…` : `Confirm with ${name}`}
    </Button>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-ink-faint" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Password, provider button and code, controlled by the caller.
 *
 * `onSsoConfirmed` runs after the provider sign-in lands, with the ticket, so a
 * caller that needs nothing else can submit straight away.
 */
export function ReauthFields({
  idPrefix,
  options,
  password,
  onPassword,
  ticket,
  onTicket,
  askCode,
  code,
  onCode,
  onError,
  onSsoConfirmed,
  passwordLabel = 'Your password',
  passwordHint,
  autoFocus,
  disabled,
}: {
  idPrefix: string;
  options: ReauthOptions | null;
  password: string;
  onPassword: (value: string) => void;
  ticket: string | null;
  onTicket: (ticket: string | null) => void;
  askCode: boolean;
  code: string;
  onCode: (value: string) => void;
  onError: (message: string | null) => void;
  onSsoConfirmed?: (ticket: string) => void;
  passwordLabel?: string;
  passwordHint?: React.ReactNode;
  autoFocus?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const sso = options?.sso ?? null;
  const passwordVisible = !sso || options?.password !== false || showPassword;

  const codeField = askCode && (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-code`}>Authenticator code</Label>
      <Input
        id={`${idPrefix}-code`}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={11}
        value={code}
        onChange={(e) => onCode(e.target.value)}
        autoFocus={Boolean(ticket)}
        disabled={disabled}
      />
      <FieldHint>From the authenticator app you set up for Helm. A recovery code works here too.</FieldHint>
    </div>
  );

  if (ticket && sso) {
    return (
      <div className="space-y-3">
        <p className="flex items-center justify-between gap-2 rounded-md border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ink">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-ok" aria-hidden />
            Confirmed with {sso.name}
          </span>
          <button
            type="button"
            className="text-xs text-ink-muted underline-offset-2 hover:underline"
            onClick={() => onTicket(null)}
            disabled={disabled}
          >
            Undo
          </button>
        </p>
        {codeField}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sso && (
        <SsoConfirmButton
          name={sso.name}
          disabled={disabled}
          onError={(message) => onError(message)}
          onConfirmed={(next) => {
            onError(null);
            onTicket(next);
            onSsoConfirmed?.(next);
          }}
        />
      )}
      {sso && passwordVisible && <OrDivider />}
      {passwordVisible && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-password`}>{passwordLabel}</Label>
          <Input
            id={`${idPrefix}-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            autoFocus={autoFocus && !sso}
            disabled={disabled}
          />
          {passwordHint && <FieldHint>{passwordHint}</FieldHint>}
        </div>
      )}
      {sso && !passwordVisible && (
        <button
          type="button"
          className="text-xs text-ink-muted underline-offset-2 hover:underline"
          onClick={() => setShowPassword(true)}
        >
          Use a password instead
        </button>
      )}
      {codeField}
    </div>
  );
}
