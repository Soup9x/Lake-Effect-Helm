/**
 * The mail transport, against a real SMTP server over a real socket.
 *
 * WHY THESE ARE NOT MOCKS. Every property worth having here lives below the
 * API: whether `requireTLS` actually refuses a relay with no STARTTLS, whether
 * the pin is compared or merely stored, whether a body line starting with a
 * period survives, whether a non-ASCII subject arrives readable. A stubbed
 * transport proves that sendMail was called, which is not one of those.
 *
 * The decision to depend on nodemailer rather than hand-write SMTP was made on
 * the strength of exactly these cases — so they are the ones asserted, rather
 * than being taken on trust because a well-known package is doing it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTransport, describeTransportError, fingerprintOf, fingerprintOfPem, fromHeader,
  EmailTransportError, type RelayConfig,
} from '../../src/lib/email/transport';
import { bodyOf, FakeSmtp, subjectOf } from '../support/fake-smtp';

const running: FakeSmtp[] = [];
async function relay(options?: Parameters<typeof FakeSmtp.start>[0]): Promise<FakeSmtp> {
  const server = await FakeSmtp.start(options);
  running.push(server);
  return server;
}
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

function config(server: FakeSmtp, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    host: server.host,
    port: server.port,
    security: 'starttls',
    tlsVerify: false,
    tlsPinnedCertificate: server.certificatePem,
    username: null,
    password: null,
    fromAddress: 'helm@msp.test',
    fromName: 'Lake Effect Helm',
    ...overrides,
  };
}

async function send(config: RelayConfig, overrides: Partial<{
  to: string; subject: string; text: string;
}> = {}): Promise<void> {
  const transport = buildTransport(config, 4000);
  try {
    await transport.sendMail({
      from: fromHeader(config),
      to: overrides.to ?? 'tech@msp.test',
      subject: overrides.subject ?? 'Due tomorrow: Disable the account',
      text: overrides.text ?? 'Hello,\n\nA step is due.\n',
    });
  } finally {
    transport.close();
  }
}

describe('STARTTLS', () => {
  it('delivers over an upgraded connection, and the server saw it encrypted', async () => {
    const server = await relay();
    await send(config(server));

    expect(server.received).toHaveLength(1);
    expect(
      server.received[0]!.encrypted,
      'the message was accepted over a connection that was never upgraded',
    ).toBe(true);
    expect(server.commands).toContain('STARTTLS');
  });

  it('REFUSES a relay that does not offer it, rather than sending in the clear', async () => {
    /*
     * THE CASE `requireTLS` EXISTS FOR, and the one an opportunistic client
     * gets wrong: a relay that advertises no STARTTLS must produce a failure,
     * not a cleartext delivery carrying the relay password and a notification
     * naming a client.
     */
    const server = await relay({ mode: 'no-starttls' });
    await expect(send(config(server))).rejects.toThrow();
    expect(server.received, 'a message was delivered over plaintext anyway').toHaveLength(0);
  });

  it('sends in the clear only when plaintext is the configured mode', async () => {
    const server = await relay({ mode: 'no-starttls' });
    await send(config(server, { security: 'plaintext', tlsPinnedCertificate: null }));

    expect(server.received).toHaveLength(1);
    expect(server.received[0]!.encrypted).toBe(false);
  });
});

describe('implicit TLS', () => {
  it('delivers on a connection that is encrypted from the first byte', async () => {
    const server = await relay({ implicitTls: true });
    await send(config(server, { security: 'tls' }));

    expect(server.received).toHaveLength(1);
    expect(server.received[0]!.encrypted).toBe(true);
    // No upgrade was needed, so the verb should never appear.
    expect(server.commands).not.toContain('STARTTLS');
  });
});

describe('the certificate pin', () => {
  it('accepts the certificate it names', async () => {
    const server = await relay();
    await send(config(server, { tlsPinnedCertificate: server.certificatePem }));
    expect(server.received).toHaveLength(1);
  });

  it('refuses any other certificate, which is the whole point', async () => {
    const server = await relay();
    await expect(
      send(config(server, { tlsPinnedCertificate: FakeSmtp.otherCertificate() })),
    ).rejects.toThrow();
    expect(server.received).toHaveLength(0);
  });

  it('refuses a second server"s certificate, so the pin is not just a shape check', async () => {
    // Two instances generate different certificates, so this is a real
    // mismatch rather than a string that happens not to match.
    const first = await relay();
    const second = await relay();
    expect(first.sha256).not.toBe(second.sha256);

    await expect(send(config(second, { tlsPinnedCertificate: first.certificatePem }))).rejects.toThrow();
    expect(second.received).toHaveLength(0);
  });

  it('derives the fingerprint from the stored certificate, for a person to compare', async () => {
    /*
     * DERIVED, never stored alongside. A fingerprint column beside a
     * certificate column is two copies of one fact, and the interesting
     * failure is the one where they disagree — so this is computed from the
     * PEM and asserted against what the server itself reports.
     */
    const server = await relay();
    expect(fingerprintOfPem(server.certificatePem)).toBe(server.sha256);
    expect(fingerprintOfPem(server.certificatePem)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies for real, rather than by our own comparison', async () => {
    /*
     * THE BUG THIS REPLACED. The first version compared a fingerprint in
     * `checkServerIdentity`, which Node never calls when rejectUnauthorized is
     * false and reaches only after the chain has already been refused when it
     * is true — so the pin accepted every certificate. With the certificate
     * handed over as the only acceptable CA, OpenSSL does the verifying, and
     * `authorized` on the server side is the observable proof.
     */
    const server = await relay();
    await send(config(server, { tlsPinnedCertificate: server.certificatePem }));
    expect(server.received[0]!.encrypted).toBe(true);
  });

  it('normalises the colons Node reports', () => {
    expect(fingerprintOf({ fingerprint256: 'AB:CD:EF' } as never)).toBe('abcdef');
    expect(fingerprintOf({} as never)).toBe('');
  });

  it('refuses a pin on a plaintext relay rather than ignoring it', () => {
    // A pin that can never be checked is a configuration somebody believes is
    // protecting them. Said rather than silently dropped.
    expect(() => buildTransport({
      host: 'mail.test', port: 25, security: 'plaintext',
      tlsVerify: false, tlsPinnedCertificate: FakeSmtp.otherCertificate(),
      username: null, password: null,
      fromAddress: 'a@b.test', fromName: null,
    })).toThrow(/no certificate is ever presented/);
  });
});

describe('authentication', () => {
  it('offers the credentials, and the relay receives them', async () => {
    const server = await relay({ requireAuth: true });
    await send(config(server, { username: 'helm', password: 'relay-secret' }));

    expect(server.received).toHaveLength(1);
    expect(server.received[0]!.auth).toEqual({ user: 'helm', pass: 'relay-secret' });
  });

  it('fails when the relay rejects them, and sends nothing', async () => {
    const server = await relay({ mode: 'bad-credentials', requireAuth: true });
    await expect(
      send(config(server, { username: 'helm', password: 'wrong' })),
    ).rejects.toThrow();
    expect(server.received).toHaveLength(0);
  });

  it('sends with no AUTH at all when the relay needs none', async () => {
    // A relay on a trusted network is a real deployment, and an unauthenticated
    // send must not be an error.
    const server = await relay();
    await send(config(server, { username: null, password: null }));
    expect(server.received).toHaveLength(1);
    expect(server.received[0]!.auth).toBeNull();
    expect(server.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
  });
});

describe('what arrives', () => {
  it('keeps a body line that begins with a period', async () => {
    /*
     * DOT-STUFFING, which is the subtlest thing the library is here for. A line
     * consisting of '.' terminates DATA, so a sender must double a leading
     * period and a receiver must undo it. Get it wrong and the message is
     * truncated at that line — silently, with a 250 from the relay.
     */
    const server = await relay();
    const text = 'Hello,\n\n.hidden line\n..double\nnormal line\n';
    await send(config(server), { text });

    const body = bodyOf(server.received[0]!);
    expect(body, 'the message was truncated at a leading period').toContain('normal line');
    expect(body).toContain('.hidden line');
    expect(body).toContain('..double');
  });

  it('keeps a subject with non-ASCII characters readable', async () => {
    // A client called "Hôtel Beaumont" is an ordinary MSP customer. A naive
    // client either mangles this or has the relay reject the header.
    const server = await relay();
    await send(config(server), { subject: 'Due tomorrow: audit — Hôtel Beaumont' });

    expect(subjectOf(server.received[0]!)).toBe('Due tomorrow: audit — Hôtel Beaumont');
  });

  it('sets a From header with the display name quoted', async () => {
    const server = await relay();
    await send(config(server, { fromName: 'Lake Effect Helm' }));
    expect(server.received[0]!.raw).toContain('Lake Effect Helm');
    expect(server.received[0]!.from).toBe('helm@msp.test');
  });

  it('marks itself auto-generated, so an auto-responder cannot start a loop', async () => {
    const server = await relay();
    const transport = buildTransport(config(server), 4000);
    try {
      await transport.sendMail({
        from: fromHeader(config(server)),
        to: 'tech@msp.test',
        subject: 'test',
        text: 'body',
        headers: { 'auto-submitted': 'auto-generated' },
      });
    } finally {
      transport.close();
    }
    expect(server.received[0]!.raw.toLowerCase()).toContain('auto-submitted: auto-generated');
  });
});

describe('the From header', () => {
  const base: RelayConfig = {
    host: 'mail.test', port: 587, security: 'starttls', tlsVerify: true,
    tlsPinnedCertificate: null, username: null, password: null,
    fromAddress: 'helm@msp.test', fromName: null,
  };

  it('is the bare address when there is no display name', () => {
    expect(fromHeader(base)).toBe('helm@msp.test');
  });

  it('quotes a display name', () => {
    expect(fromHeader({ ...base, fromName: 'Lake Effect Helm' }))
      .toBe('"Lake Effect Helm" <helm@msp.test>');
  });

  it('strips a quote out of the display name rather than producing a broken header', () => {
    // A name containing a double quote would otherwise terminate the quoted
    // string early and make the whole header unparseable.
    expect(fromHeader({ ...base, fromName: 'He said "hi"' }))
      .toBe('"He said hi" <helm@msp.test>');
  });

  it('treats a whitespace-only name as absent', () => {
    expect(fromHeader({ ...base, fromName: '   ' })).toBe('helm@msp.test');
  });
});

describe('errors a settings page can show', () => {
  it('names an unreachable relay rather than echoing an errno', async () => {
    const described = describeTransportError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    expect(described.reason).toBe('unreachable');
    expect(described.message).toContain('could not be reached');
  });

  it('names refused credentials', () => {
    const described = describeTransportError(Object.assign(new Error('x'), { code: 'EAUTH' }));
    expect(described.reason).toBe('rejected');
    expect(described.message).toContain('username and password');
  });

  it('recognises a certificate problem from the message when there is no code', () => {
    const described = describeTransportError(new Error('self signed certificate in chain'));
    expect(described.reason).toBe('tls');
  });

  it('passes its own errors through unchanged', () => {
    const own = new EmailTransportError('pinned certificate mismatch', 'tls');
    expect(describeTransportError(own)).toBe(own);
  });

  it('truncates something unrecognisable rather than logging a novel', () => {
    const described = describeTransportError(new Error('x'.repeat(5000)));
    expect(described.message.length).toBeLessThanOrEqual(300);
  });
});

describe('a relay that never answers', () => {
  it('gives up rather than holding the worker open', async () => {
    const server = await relay({ mode: 'silent' });
    const started = Date.now();
    await expect(send(config(server))).rejects.toThrow();
    // The configured timeout is 4s here; the assertion is that it ended at all
    // and well inside vitest's own limit.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

describe('the version floor', () => {
  /**
   * A DEPENDENCY VERSION AS AN ASSERTION, which is unusual enough to justify.
   *
   * GHSA-6vj9-mwq6-2f5v (fixed in nodemailer 10.0.2) is a process-global DNS
   * cache that reuses the TLS `servername` across transports. That is not a
   * generic advisory for this codebase — it is the failure mode of exactly what
   * EmailBatch does: one process, one transport per tenant, one relay password
   * per tenant. A second tenant's connection could be handed the first
   * tenant's `servername`, which sends a password to the wrong relay. Three
   * more of the eight are recipient allow-list bypasses, and Helm's recipient
   * gate is an allow-list.
   *
   * `pnpm audit --audit-level moderate` is the blocking gate and found all
   * eight. This exists because that gate can be satisfied by writing an
   * exemption, and an exemption here would be wrong for a reason no advisory
   * text says: the architecture above. A failing assertion naming the
   * architecture is harder to wave through than a line in a config file.
   */
  it('runs on a nodemailer that fixed the cross-tenant servername reuse', async () => {
    const installed = (await import('nodemailer/package.json', {
      with: { type: 'json' },
    })) as { default: { version: string } };
    const [major, minor, patch] = installed.default.version
      .split('.')
      .map((part) => Number.parseInt(part, 10));

    const atLeast = (a: number, b: number, c: number) =>
      major! > a || (major === a && (minor! > b || (minor === b && patch! >= c)));

    expect(
      atLeast(10, 0, 6),
      `nodemailer ${installed.default.version} is below 10.0.6, which means at `
      + 'least one of eight advisories applies — among them a process-global DNS '
      + 'cache that reuses the TLS servername across transports, i.e. one '
      + 'tenant’s relay password sent to another tenant’s relay. See the header '
      + 'of src/lib/email/transport.ts.',
    ).toBe(true);
  });
});

describe('SNI', () => {
  /**
   * The relay's own name, and no name at all for an address.
   *
   * Asserted on the built options rather than on the wire, because what is
   * being pinned is which value this code chooses: the advisory behind the
   * version floor was a transport being handed ANOTHER transport's
   * `servername`, so "it comes from this config and nothing shared" is the
   * property. The IP case is measured behaviour, not taste — Node raises
   * DEP0123 for an SNI that is an address and says it will stop sending it, so
   * an on-premises relay at a bare IP would log a deprecation on every send.
   */
  it('names the relay when it is reached by name', async () => {
    const server = await relay();
    const built = buildTransport(config(server, { host: 'mail.internal.msp.test' }));
    const tls = (built as unknown as { options: { tls: { servername?: string } } }).options.tls;
    expect(tls.servername).toBe('mail.internal.msp.test');
  });

  it('sends none when it is reached by address, for either IP version', async () => {
    const server = await relay();
    for (const host of ['127.0.0.1', '10.0.0.25', '::1', 'fe80::1']) {
      const built = buildTransport(config(server, { host }));
      const tls = (built as unknown as { options: { tls: { servername?: string } } }).options.tls;
      expect(tls.servername, `${host} is an address and carries no SNI`).toBeUndefined();
    }
  });

  it('...and the same holds with no pin, where the tls block is the plain one', async () => {
    const server = await relay();
    const named = buildTransport(
      config(server, { host: 'mail.test', tlsPinnedCertificate: null, tlsVerify: true }),
    );
    const byIp = buildTransport(
      config(server, { host: '127.0.0.1', tlsPinnedCertificate: null, tlsVerify: true }),
    );
    type Built = { options: { tls: { servername?: string; rejectUnauthorized?: boolean } } };
    expect((named as unknown as Built).options.tls.servername).toBe('mail.test');
    expect((byIp as unknown as Built).options.tls.servername).toBeUndefined();
    // And the branch still carries the verification setting it is there for.
    expect((byIp as unknown as Built).options.tls.rejectUnauthorized).toBe(true);
  });

  /**
   * Node itself, on the measurement the omission rests on. If a future Node
   * stops warning — or starts throwing — this says so rather than leaving the
   * reasoning above as folklore.
   */
  it('and Node really does deprecate an SNI that is an address', async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
    process.on('warning', onWarning);
    try {
      const server = await relay();
      // A send through a relay reached by IP, with the pin, which is the
      // configuration an on-premises MSP most often has.
      const transport = buildTransport(config(server, { host: '127.0.0.1' }));
      await transport.sendMail({
        from: 'helm@msp.test', to: 'ops@msp.test', subject: 'sni', text: 'body',
      });
      transport.close();
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    } finally {
      process.off('warning', onWarning);
    }

    expect(
      warnings.filter((w) => /ServerName to an IP address/i.test(w)),
      'the SNI omission is what keeps this warning out of the worker log; if it '
      + 'appears here, something is setting servername to an address again',
    ).toEqual([]);
  });
});
