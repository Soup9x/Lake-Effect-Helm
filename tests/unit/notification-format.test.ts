/**
 * The payload each platform actually accepts.
 *
 * These assertions exist because the 0110 comment claiming one `{ text }` body
 * "covers Slack, Teams and anything with an inbound URL" was two-thirds right,
 * and the third that was wrong — Discord — failed silently with a 400 that
 * looks exactly like a bad URL.
 *
 * So each case asserts the SHAPE THE PLATFORM REQUIRES, not that a function
 * returned something.
 */
import { describe, expect, it } from 'vitest';
import {
  discord,
  fields,
  formatPayload,
  generic,
  severityOf,
  slack,
  teams,
  type NotificationEvent,
} from '../../src/lib/notifications/format';

const EVENT: NotificationEvent = {
  event: 'export.requested',
  subject: 'Northwind Admin requested a CREDENTIAL-BEARING export for Acme Manufacturing',
  payload: { include_secrets: true, kind: 'client_offboarding', format: 'zip' },
  occurredAt: new Date('2026-09-18T09:30:00.000Z'),
  organizationName: 'Acme Manufacturing',
  tenantName: 'Northwind Managed Services',
};

describe('discord', () => {
  it('sends content AND an embed, because an embed alone has no notification preview', () => {
    const body = discord(EVENT) as { content: string; embeds: unknown[] };
    expect(body.content).toContain('CREDENTIAL-BEARING');
    expect(body.embeds).toHaveLength(1);
  });

  it('NEVER sends a bare text field — Discord answers 400', () => {
    expect(discord(EVENT)).not.toHaveProperty('text');
  });

  it('colours a credential-bearing export as critical', () => {
    const body = discord(EVENT) as { embeds: { color: number }[] };
    expect(body.embeds[0]!.color).toBe(0xdc2626);
  });

  it('respects the 25-field and 1024-character embed limits', () => {
    // Exceeding either is a 400, which is indistinguishable from a bad URL.
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field_${i}`, 'x'.repeat(2000)]),
    );
    const body = discord({ ...EVENT, payload: many }) as {
      embeds: { fields: { value: string }[] }[];
    };
    expect(body.embeds[0]!.fields).toHaveLength(25);
    for (const field of body.embeds[0]!.fields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
  });
});

describe('teams', () => {
  it('sends an Adaptive Card in an attachment envelope, which Workflows accepts', () => {
    const body = teams(EVENT) as {
      type: string;
      attachments: { contentType: string; content: { type: string; body: unknown[] } }[];
    };
    expect(body.type).toBe('message');
    expect(body.attachments[0]!.contentType).toBe(
      'application/vnd.microsoft.card.adaptive',
    );
    expect(body.attachments[0]!.content.type).toBe('AdaptiveCard');
  });

  it('is NOT the retired Office 365 MessageCard format', () => {
    // Defaulting to the dead format would send every new deployment down a
    // path Microsoft has closed.
    expect(JSON.stringify(teams(EVENT))).not.toContain('MessageCard');
  });
});

describe('slack', () => {
  it('puts the whole sentence in text, which is the notification preview', () => {
    const body = slack(EVENT) as { text: string };
    expect(body.text).toBe(EVENT.subject);
  });
});

describe('generic', () => {
  it('is a flat, stable shape somebody can write a receiver against', () => {
    const body = generic(EVENT) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: 'export.requested',
      severity: 'critical',
      tenant: 'Northwind Managed Services',
      organization: 'Acme Manufacturing',
      source: 'lake-effect-helm',
    });
    expect(body.data).toEqual(EVENT.payload);
  });
});

describe('every format', () => {
  it('says the same words, whatever the shape', () => {
    for (const format of ['generic', 'slack', 'discord', 'teams'] as const) {
      expect(JSON.stringify(formatPayload(format, EVENT))).toContain(
        'requested a CREDENTIAL-BEARING export',
      );
    }
  });

  it('carries no key the payload did not already have', () => {
    // The allow-list lives in SQL. Nothing in the formatters may reach back for
    // more than it was handed.
    for (const format of ['generic', 'slack', 'discord', 'teams'] as const) {
      const rendered = JSON.stringify(formatPayload(format, EVENT));
      expect(rendered).not.toContain('password');
      expect(rendered).not.toContain('ciphertext');
    }
  });
});

describe('severity', () => {
  it('is loudest for the thing 0400 removed the approval gate from', () => {
    expect(severityOf(EVENT)).toBe('critical');
    expect(severityOf({ ...EVENT, payload: { include_secrets: false } })).toBe('notice');
  });

  it('escalates an expiry that has already passed', () => {
    const expiring = { ...EVENT, event: 'expiration.warning' };
    expect(severityOf({ ...expiring, payload: { days_remaining: 30 } })).toBe('notice');
    expect(severityOf({ ...expiring, payload: { days_remaining: 3 } })).toBe('warning');
    expect(severityOf({ ...expiring, payload: { days_remaining: -2 } })).toBe('critical');
  });
});

describe('field rendering', () => {
  it('orders known keys predictably, so a card does not reshuffle', () => {
    const rendered = fields(EVENT).map(([label]) => label);
    expect(rendered).toEqual(['Include secrets', 'Kind', 'Format']);
  });

  it('shows an unrecognised key rather than dropping it', () => {
    // It made it through the SQL allow-list, so somebody chose to send it.
    const rendered = fields({ ...EVENT, payload: { zebra: 1, kind: 'x' } });
    expect(rendered.map(([label]) => label)).toEqual(['Kind', 'Zebra']);
  });

  it('renders booleans and nulls as words, not as "undefined"', () => {
    const rendered = new Map(fields({ ...EVENT, payload: { include_secrets: false, label: null } }));
    expect(rendered.get('Include secrets')).toBe('no');
    expect(rendered.get('Label')).toBe('—');
  });
});
