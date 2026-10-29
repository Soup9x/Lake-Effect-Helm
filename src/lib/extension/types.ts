/**
 * The shapes the browser extension reads, shared by the routes and the
 * extension's bundle. Types only: nothing here runs.
 */

/** One credential the popup can list. */
export interface ExtensionEntry {
  /** 'client' is a credential documented under a client; 'personal' is the person's own vault. */
  kind: 'client' | 'personal';
  /** The credential's asset node id, or the personal entry's id. */
  id: string;
  name: string;
  organizationId: string | null;
  organizationName: string | null;
  username: string | null;
  url: string | null;
  /**
   * How it matched the site, for a lookup: 'host' when the credential names
   * this exact host, 'site' when it names another host under the same
   * registrable domain. Null for a search result.
   */
  match: 'host' | 'site' | null;
  hasPassword: boolean;
  hasTotp: boolean;
  /**
   * Whether the extension may copy the password at all. False for anything
   * but a standard secret, and for one that needs a step-up, which a token can
   * never give (1120). The popup offers "Open in Helm" instead.
   */
  passwordCopyable: boolean;
  /** The reveal needs a justification of at least 10 characters. */
  requiresReason: boolean;
  /** Where the password is revealed from: the secret id, for a client credential. */
  secretId: string | null;
}

export interface ExtensionLookup {
  /** The host the server matched against, as it normalised it. */
  host: string | null;
  /** Its registrable domain, or null for an IP address or a bare name. */
  site: string | null;
  entries: ExtensionEntry[];
  /**
   * Only when nothing matched: what the person copied or opened lately, and,
   * for MSP staff, what is copied most. Never both lists holding one entry.
   */
  suggestions?: { recent: ExtensionEntry[]; popular: ExtensionEntry[] } | undefined;
}

export interface ExtensionMe {
  installId: string;
  label: string;
  userName: string;
  userEmail: string;
  tenantId: string;
  tenantName: string;
  expiresAt: string;
  /** Whether this pairing may save and update logins (1200); false for one paired before. */
  canSave: boolean;
}

export interface ExtensionPairing {
  installId: string;
  token: string;
  expiresAt: string;
  tenantName: string;
  keySha256: string;
}

/** Where the extension may save a login: the person's own vault, or a client and one of its sites. */
export interface ExtensionDestinations {
  /**
   * False when this pairing was approved before saving existed (1200), or for
   * somebody whose role cannot write credentials. The extension then says
   * how to get it: pair again.
   */
  canSave: boolean;
  organizations: { id: string; name: string; sites: { id: string; name: string }[] }[];
}

/** After a sign-in: whether to offer a save, an update, or nothing. */
export interface ExtensionLoginCheck {
  state: 'new' | 'same' | 'changed' | 'skip';
  host: string;
  /** The login it matched, for 'same', 'changed' and some 'skip's. */
  entry: ExtensionEntry | null;
  canSave: boolean;
}

/** What a save or an update returns: where it went, never what it holds. */
export interface ExtensionSaved {
  kind: 'client' | 'personal';
  id: string;
  name: string;
}
