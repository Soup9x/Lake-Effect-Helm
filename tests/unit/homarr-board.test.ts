import { describe, expect, it } from 'vitest';
import { integrationHealth, normaliseOrigin, summariseIntegrations, type BoardIntegration } from '../../src/lib/homarr/board';
import { esc, renderBoardPage } from '../../src/lib/homarr/page';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const conn = (over: Partial<BoardIntegration>): BoardIntegration => ({
  provider: 'ninja_one', name: null, status: 'active', syncEnabled: true, intervalMinutes: 60,
  lastSyncAt: '2026-11-02T11:30:00Z', lastSuccessAt: '2026-11-02T11:30:00Z', failures: 0, ...over,
});

describe('normaliseOrigin', () => {
  it('keeps scheme, host and port and nothing else', () => {
    expect(normaliseOrigin(' http://192.168.3.6:7575/board/home?x=1 ')).toBe('http://192.168.3.6:7575');
    expect(normaliseOrigin('https://homarr.malloryhost.com/')).toBe('https://homarr.malloryhost.com');
    expect(normaliseOrigin('https://homarr.example.com:443')).toBe('https://homarr.example.com');
  });
  it('refuses anything a CSP could misread', () => {
    for (const bad of ['*', 'homarr.example.com', 'javascript:alert(1)', 'https://u:p@h.example.com', 'data:text/html,x']) {
      expect(normaliseOrigin(bad), bad).toBeNull();
    }
  });
});

describe('integration health', () => {
  it('is late after three missed intervals, failing on any failure, paused when off', () => {
    expect(integrationHealth(conn({}), NOW)).toBe('ok');
    expect(integrationHealth(conn({ lastSuccessAt: '2026-11-02T08:30:00Z' }), NOW)).toBe('late');
    expect(integrationHealth(conn({ failures: 2 }), NOW)).toBe('failing');
    expect(integrationHealth(conn({ syncEnabled: false, failures: 2 }), NOW)).toBe('paused');
    expect(integrationHealth(conn({ lastSuccessAt: null }), NOW)).toBe('never');
  });
  it('groups by provider and keeps the worst', () => {
    const rows = summariseIntegrations([
      conn({ provider: 'microsoft_graph', name: 'Acme' }),
      conn({ provider: 'microsoft_graph', name: 'Globex', failures: 1 }),
      conn({ provider: 'proxmox' }),
    ], NOW);
    expect(rows.map((r) => [r.label, r.connections, r.worst, r.failingNames])).toEqual([
      ['Microsoft 365', 2, 'failing', ['Globex']],
      ['Proxmox', 1, 'ok', []],
    ]);
  });
});

describe('the page', () => {
  it('escapes everything people typed', () => {
    expect(esc('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    const html = renderBoardPage({
      tenant: '<b>MSP</b>', linkName: 'x', showDetails: true, allowedOrigins: [],
      counts: { expired: 0, critical: 1, warning: 0, clients: 1, devices: 0 },
      expirations: [{
        id: '1', label: '<script>alert(1)</script>', kind: 'domain_registration', organizationId: 'o',
        organization: 'A & B', nodeId: null, expiresAt: '2026-11-07T00:00:00Z', daysRemaining: 5,
        severity: 'critical', autoRenew: false,
      }],
      integrations: [], generatedAt: '2026-11-02T12:00:00Z',
    }, { theme: 'dark', transparent: false }, NOW);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>MSP</b>');
    expect(html).toContain('A &amp; B');
  });
});
