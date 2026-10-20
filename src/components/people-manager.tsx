'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, Plus, ShieldOff, UserPlus, X } from 'lucide-react';
import { Button } from './ui/button';
import { MemberPermissionsDialog } from './member-permissions-dialog';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { apiFetch, type ApiRequest } from '@/lib/ui/api';
import { SignInDialog, lastEmailLine, type MemberSignIn } from './sign-in-dialog';
import { PasswordGenerator } from './password-generator';

/**
 * Who has access to this tenant.
 *
 * The role picker offers only what the server said is grantable — every role at
 * or below the caller's own rank. That is a convenience, not a control: the
 * database refuses anything above it (0350) whatever the browser sends, and the
 * route turns that refusal into a message. A picker built from a hard-coded
 * list would be a second opinion about authority, and the two would drift.
 *
 * Rows the caller may not act on carry no controls at all, including their own.
 * An administrator cannot change their own access here — somebody else does it,
 * so a mistake cannot leave a tenant nobody can administer.
 *
 * PERMISSIONS ARE A SEPARATE DIALOG, not a column. A role is one value and fits
 * in a picker; the per-person exceptions on top of it are a list with a reason
 * and an expiry on each, and flattening that into a cell would say "three
 * overrides" without saying which or why. The button is offered on every row,
 * including ones this caller cannot edit — seeing that somebody holds an
 * exception is part of reading the access model, and the dialog decides for
 * itself whether to show the controls.
 */
interface Member {
  userId: string;
  email: string;
  name: string | null;
  roleKey: string;
  roleName: string;
  rank: number;
  status: string;
  orgScopeAll: boolean;
  orgScope: string[];
  lastLoginAt: string | null;
  editable: boolean;
  /** The caller's own row. A different question from `editable`. */
  isSelf: boolean;
  /** Has an authenticator for local sign-in (0960). */
  hasTotp: boolean;
  /** Local password or not, and the last account email (1000). */
  signIn: MemberSignIn;
}

interface Role {
  key: string;
  name: string;
  rank: number;
  isTenantWide: boolean;
}

interface Organization {
  id: string;
  name: string;
}

export function PeopleManager({
  members,
  grantableRoles,
  organizations,
  canWrite,
}: {
  members: Member[];
  grantableRoles: Role[];
  organizations: Organization[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [inviting, setInviting] = useState(false);
  const [permissionsFor, setPermissionsFor] = useState<Member | null>(null);
  const [signInFor, setSignInFor] = useState<Member | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(url: string, init: ApiRequest): Promise<boolean> {
    setError(null);
    const result = await apiFetch(url, init);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    router.refresh();
    return true;
  }

  async function changeRole(userId: string, roleKey: string) {
    const role = grantableRoles.find((r) => r.key === roleKey);
    if (!role) return;
    setBusyRow(userId);
    // A client-side role has to be pinned. Offering the change without saying
    // where to pin it would produce a refusal the person cannot act on, so the
    // first organisation is proposed and the row can be re-scoped after.
    const scope = role.isTenantWide
      ? { orgScopeAll: true }
      : { orgScopeAll: false, orgScope: organizations[0] ? [organizations[0].id] : [] };
    await call(`/api/users/${userId}`, {
      method: 'PATCH',
      json: { roleKey, ...scope },
    });
    setBusyRow(null);
  }

  async function resetTotp(userId: string, email: string) {
    if (!window.confirm(`Reset ${email}'s authenticator? Their app and recovery codes stop working; they set up a new one at their next local sign-in if one is required.`))
      return;
    setBusyRow(userId);
    await call(`/api/users/${userId}/totp`, { method: 'DELETE' });
    setBusyRow(null);
  }

  async function revoke(userId: string, email: string) {
    if (!window.confirm(`Revoke ${email}'s access to this tenant? Their sessions end immediately.`))
      return;
    setBusyRow(userId);
    await call(`/api/users/${userId}?reason=revoked%20from%20the%20people%20page`, {
      method: 'DELETE',
    });
    setBusyRow(null);
  }

  return (
    <div className="space-y-4">
      {canWrite && !inviting && (
        <Button variant="primary" onClick={() => setInviting(true)} className="gap-2">
          <UserPlus />
          Add a person
        </Button>
      )}

      {inviting && (
        <InviteForm
          grantableRoles={grantableRoles}
          organizations={organizations}
          onDone={(message) => {
            setInviting(false);
            setNotice(message);
            router.refresh();
          }}
          onCancel={() => setInviting(false)}
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-ok">{notice}</p>}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell>
                    <div className="text-ink">{m.name ?? m.email}</div>
                    {m.name && <div className="text-xs text-ink-faint">{m.email}</div>}
                    {(() => {
                      const line = lastEmailLine(m.signIn);
                      return line && (
                        <div className={line.tone === 'danger' ? 'text-xs text-danger'
                          : line.tone === 'ok' ? 'text-xs text-ink-muted' : 'text-xs text-ink-faint'}>
                          {line.text}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    {canWrite && m.editable ? (
                      <Select
                        value={m.roleKey}
                        disabled={busyRow === m.userId}
                        onChange={(e) => changeRole(m.userId, e.target.value)}
                        className="max-w-48"
                      >
                        {/* The current role may outrank what this caller can
                            grant; showing it keeps the select honest, and the
                            server refuses a move back up to it. */}
                        {!grantableRoles.some((r) => r.key === m.roleKey) && (
                          <option value={m.roleKey}>{m.roleName}</option>
                        )}
                        {grantableRoles.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-ink-muted">{m.roleName}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-ink-muted">
                    {m.orgScopeAll ? (
                      'Every client'
                    ) : (
                      <span>
                        {m.orgScope.length} client{m.orgScope.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone={m.status === 'active' ? 'ok' : 'danger'}>{m.status}</Badge>
                    {m.signIn.hasLocalPassword && (
                      <Badge tone="neutral" className="ml-1" title={m.signIn.mustChange ? 'Must change it at next sign-in' : undefined}>
                        Local password{m.signIn.mustChange ? ' (temporary)' : ''}
                      </Badge>
                    )}
                    {m.hasTotp && <Badge tone="neutral" className="ml-1">2-step</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPermissionsFor(m)}
                        className="gap-1.5"
                        title="Exceptions to what this person's role carries"
                      >
                        <KeyRound />
                        Permissions
                      </Button>
                      {canWrite && m.editable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSignInFor(m)}
                          title="Email a password link, set a password, or make a one-time link"
                        >
                          Sign-in
                        </Button>
                      )}
                      {canWrite && m.hasTotp && !m.isSelf && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyRow === m.userId}
                          onClick={() => resetTotp(m.userId, m.email)}
                          title="For a lost phone: their authenticator and recovery codes stop working"
                        >
                          Reset 2-step
                        </Button>
                      )}
                      {canWrite && m.editable && m.status === 'active' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyRow === m.userId}
                          onClick={() => revoke(m.userId, m.email)}
                          className="gap-1.5 text-danger"
                        >
                          {busyRow === m.userId ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <ShieldOff />
                          )}
                          Revoke
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {signInFor && (
        <SignInDialog
          userId={signInFor.userId}
          email={signInFor.email}
          label={signInFor.name ?? signInFor.email}
          signIn={signInFor.signIn}
          open
          onOpenChange={(next) => {
            if (!next) setSignInFor(null);
          }}
        />
      )}

      {permissionsFor && (
        <MemberPermissionsDialog
          userId={permissionsFor.userId}
          label={permissionsFor.name ?? permissionsFor.email}
          // `editable` is false for your own row AND for one that outranks you.
          // Only the first is what the permissions route refuses, so it is
          // derived here rather than reused.
          isSelf={permissionsFor.isSelf}
          open
          onOpenChange={(next) => {
            if (!next) setPermissionsFor(null);
          }}
        />
      )}
    </div>
  );
}

function InviteForm({
  grantableRoles,
  organizations,
  onDone,
  onCancel,
}: {
  grantableRoles: Role[];
  organizations: Organization[];
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [signIn, setSignIn] = useState<'sso' | 'email_link' | 'password'>('email_link');
  const [notify, setNotify] = useState(true);
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleKey, setRoleKey] = useState(grantableRoles[0]?.key ?? '');
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const role = grantableRoles.find((r) => r.key === roleKey);
  const needsPinning = role !== undefined && !role.isTenantWide;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/users', {
        json: {
          email: email.trim(),
          roleKey,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(needsPinning ? { orgScopeAll: false, orgScope: [orgId] } : { orgScopeAll: true }),
          signIn,
          notify,
          ...(signIn === 'password' ? { password, mustChange } : {}),
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const who = name.trim() || email.trim();
      onDone(signIn === 'email_link'
        ? `Added ${who}. A link to choose their password is on its way; whether it went shows on their row.`
        : signIn === 'password'
          ? `Added ${who} with the password you set. Give it to them directly${mustChange ? '; they choose their own at first sign-in' : ''}.`
          : notify
            ? `Added ${who}. An email telling them they have access is on its way.`
            : `Added ${who}. They can sign in with single sign-on.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
              <Plus className="size-4" />
              Add a person
            </h2>
            <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label="Cancel">
              <X />
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                maxLength={254}
              />
              <FieldHint>
                If they already have an account, this adds access rather than a second one.
              </FieldHint>
            </div>

            <div>
              <Label htmlFor="invite-name">Name</Label>
              <Input
                id="invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Optional"
                maxLength={200}
              />
            </div>

            <div>
              <Label htmlFor="invite-role">Role</Label>
              <Select
                id="invite-role"
                value={roleKey}
                onChange={(e) => setRoleKey(e.target.value)}
              >
                {grantableRoles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </Select>
              <FieldHint>Only roles at or below your own are offered.</FieldHint>
            </div>

            {needsPinning && (
              <div>
                <Label htmlFor="invite-org">Client</Label>
                <Select id="invite-org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
                <FieldHint>
                  A client-side role must be pinned — it sees this client and no other.
                </FieldHint>
              </div>
            )}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">How they sign in</legend>
            {([
              ['email_link', 'Local account — email them a link to choose a password',
                'The link works once, for a day. Needs the mail relay set up under Settings.'],
              ['password', 'Local account — set a password now',
                'You give it to them directly. Useful when email is not set up yet.'],
              ['sso', 'Single sign-on',
                'They sign in with Microsoft or your identity provider using this address.'],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className="flex items-start gap-2 text-sm text-ink">
                <input type="radio" name="invite-sign-in" value={value} checked={signIn === value}
                  onChange={() => setSignIn(value)} className="mt-0.5 size-4" />
                <span>
                  {label}
                  <span className="block text-xs text-ink-muted">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {signIn === 'password' && (
            <div className="space-y-2">
              <Label htmlFor="invite-password">Password</Label>
              <div className="flex items-end gap-2">
                <Input id="invite-password" type="text" autoComplete="off" spellCheck={false} minLength={12}
                  required value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 12 characters" className="flex-1" />
                <PasswordGenerator onUse={setPassword} />
              </div>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)}
                  className="size-4 rounded border-border-strong" />
                They must choose their own at their first sign-in
              </label>
            </div>
          )}
          {signIn === 'sso' && (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)}
                className="size-4 rounded border-border-strong" />
              Email them that they have access
            </label>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={busy || !email.trim() || !roleKey || (needsPinning && !orgId)
              || (signIn === 'password' && password.length < 12)}
          >
            {busy && <Loader2 className="animate-spin" />}
            {busy ? 'Adding…' : signIn === 'email_link' || (signIn === 'sso' && notify) ? 'Add and send email' : 'Add person'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
