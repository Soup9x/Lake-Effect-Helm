'use client';

/**
 * The per-site network diagram.
 *
 * WHY SVG AND NOT A LIBRARY. v1 draws boxes and straight lines and lets you
 * drag a box. That is a few hundred lines of pointer handling against an SVG,
 * and the alternative — react-flow or d3 — is a dependency in the process that
 * holds decrypted client credentials, for a feature that does not need a force
 * simulation. If the diagram ever wants orthogonal routing or nested groups,
 * that is the moment to reconsider, not before.
 *
 * WHAT IS PERSISTED AND WHAT IS NOT.
 *
 * A drag writes pos_x/pos_y immediately, on pointer-up, and nothing else. The
 * auto-layout that places a node which has never been positioned is display
 * only: it is recomputed on every load and never written back, because "has a
 * person placed this?" is the question the whole non-destructive sync contract
 * turns on, and silently answering yes on first render would destroy it.
 *
 * DELETING A SYNCED NODE IS NOT A DELETE, and the interface says so in those
 * words before it happens. It removes the box; the next poll puts it back if
 * the controller still reports the device, and leaves it gone if it does not.
 * Telling somebody that afterwards, when the box reappears, would be a bug
 * report rather than a feature.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Network, Plus, RefreshCw, Router, Server, Shield, Trash2, Wifi, X,
} from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Modal } from './ui/modal';
import { Badge } from './ui/badge';

const DEVICE_TYPES = [
  ['switch', 'Switch'],
  ['router', 'Router'],
  ['firewall', 'Firewall'],
  ['server', 'Server'],
  ['access_point', 'Access point'],
  ['generic', 'Other'],
] as const;

type DeviceType = (typeof DEVICE_TYPES)[number][0];

const ICONS: Record<DeviceType, typeof Network> = {
  switch: Network,
  router: Router,
  firewall: Shield,
  server: Server,
  access_point: Wifi,
  generic: Network,
};

interface TopologyNode {
  id: string;
  assetNodeId: string | null;
  label: string;
  ipAddress: string | null;
  subnet: string | null;
  deviceType: DeviceType;
  posX: number | null;
  posY: number | null;
  source: 'manual' | 'unifi_sync';
}

interface TopologyLink {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label: string | null;
  source: 'manual' | 'unifi_sync';
}

interface Graph {
  site: { id: string; name: string };
  unifiBound: boolean;
  nodes: TopologyNode[];
  links: TopologyLink[];
}

/** Box geometry. Shared by the renderer and the hit testing, so they agree. */
const BOX = { w: 168, h: 56, gapX: 208, gapY: 104, perRow: 4, originX: 40, originY: 36 };

/**
 * Where to draw a node that has never been positioned.
 *
 * A grid in creation order: deterministic, so the diagram does not rearrange
 * itself between two people looking at it, and good enough that the first drag
 * is an adjustment rather than a rescue. Not written back — see the header.
 */
function layout(nodes: TopologyNode[]): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  let i = 0;
  for (const node of nodes) {
    if (node.posX !== null && node.posY !== null) {
      placed.set(node.id, { x: node.posX, y: node.posY });
      continue;
    }
    placed.set(node.id, {
      x: BOX.originX + (i % BOX.perRow) * BOX.gapX,
      y: BOX.originY + Math.floor(i / BOX.perRow) * BOX.gapY,
    });
    i += 1;
  }
  return placed;
}

export interface TopologyDesignerProps {
  siteId: string;
  siteName: string;
  /** False for a viewer: the canvas still renders, nothing is draggable. */
  canEdit: boolean;
}

export function TopologyDesigner({ siteId, siteName, canEdit }: TopologyDesignerProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Positions being rendered, including drags in flight. */
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  /** The node a link is being drawn from, if any. */
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const surface = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${siteId}/topology`);
      if (!response.ok) {
        setError('The diagram could not be loaded.');
        return;
      }
      const next = (await response.json()) as Graph;
      setGraph(next);
      setPositions(layout(next.nodes));
    } catch {
      setError('The request failed. Check your connection and retry.');
    } finally {
      setBusy(false);
    }
  }, [siteId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /** One place that turns a failed write into a message, since every action writes. */
  const send = useCallback(async (path: string, init: RequestInit): Promise<unknown | null> => {
    try {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? 'That change was refused.');
        return null;
      }
      return payload;
    } catch {
      setError('The request failed. Check your connection and retry.');
      return null;
    }
  }, []);

  // -- dragging ------------------------------------------------------------
  const pointFor = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = surface.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };

  const onNodePointerDown = (event: React.PointerEvent, node: TopologyNode) => {
    if (!canEdit || linkingFrom !== null) return;
    const at = positions.get(node.id);
    if (!at) return;
    const p = pointFor(event);
    drag.current = { id: node.id, dx: p.x - at.x, dy: p.y - at.y, moved: false };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pointFor(event);
    d.moved = true;
    setPositions((prev) => {
      const next = new Map(prev);
      next.set(d.id, { x: Math.max(0, p.x - d.dx), y: Math.max(0, p.y - d.dy) });
      return next;
    });
  };

  /**
   * Persist on release, not on every frame.
   *
   * A drag is a hundred pointer events; a hundred PATCHes would be a hundred
   * audit-free writes and a visibly laggy box. The position on screen is the
   * truth until the pointer comes up, and then it is written once.
   */
  const onPointerUp = async () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;

    const at = positions.get(d.id);
    if (!at) return;
    await send(`/api/sites/${siteId}/topology/nodes/${d.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ posX: Math.round(at.x), posY: Math.round(at.y) }),
    });
  };

  // -- actions -------------------------------------------------------------
  const onNodeClick = async (node: TopologyNode) => {
    if (drag.current?.moved) return;

    if (linkingFrom !== null) {
      if (linkingFrom === node.id) { setLinkingFrom(null); return; }
      const created = await send(`/api/sites/${siteId}/topology/links`, {
        method: 'POST',
        body: JSON.stringify({ fromNodeId: linkingFrom, toNodeId: node.id }),
      });
      setLinkingFrom(null);
      if (created) await load();
      return;
    }
    setSelected((prev) => (prev === node.id ? null : node.id));
  };

  const removeNode = async (node: TopologyNode) => {
    if (node.source === 'unifi_sync' && graph?.unifiBound) {
      const ok = window.confirm(
        `“${node.label}” came from UniFi.\n\n` +
        'Removing it here takes it off the diagram, but the next sync will put ' +
        'it back for as long as the controller still reports the device. It ' +
        'stays gone only once the device is genuinely off the controller.\n\n' +
        'Remove it anyway?',
      );
      if (!ok) return;
    }
    if (await send(`/api/sites/${siteId}/topology/nodes/${node.id}`, { method: 'DELETE' })) {
      setSelected(null);
      await load();
    }
  };

  const removeLink = async (link: TopologyLink) => {
    if (await send(`/api/sites/${siteId}/topology/links/${link.id}`, { method: 'DELETE' })) {
      setSelected(null);
      await load();
    }
  };

  const openAsset = (node: TopologyNode) => {
    if (!node.assetNodeId) return;
    setOpen(false);
    router.push(`/assets/${node.assetNodeId}`);
  };

  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === selected) ?? null,
    [graph, selected],
  );
  const selectedLink = useMemo(
    () => graph?.links.find((l) => l.id === selected) ?? null,
    [graph, selected],
  );

  const extent = useMemo(() => {
    let w = 720;
    let h = 360;
    for (const { x, y } of positions.values()) {
      w = Math.max(w, x + BOX.w + 40);
      h = Math.max(h, y + BOX.h + 40);
    }
    return { w, h };
  }, [positions]);

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Network className="size-4" />
        Topology
      </Button>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title={`${siteName} — network topology`}
        description="What is plugged into what. Separate from asset dependencies, which record reliance rather than cabling."
        icon={Network}
        size="lg"
      >
        <div className="space-y-3">
          {error && (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
                  <Plus className="size-4" />
                  Add node
                </Button>
                <Button
                  size="sm"
                  variant={linkingFrom ? 'primary' : 'secondary'}
                  onClick={() => { setLinkingFrom(null); setSelected(null); setAdding(false); }}
                  disabled={linkingFrom === null}
                >
                  Cancel link
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh
            </Button>
            {graph?.unifiBound && <Badge tone="brand">UniFi-fed</Badge>}
            {linkingFrom && (
              <span className="text-xs text-ink-muted">
                Pick the second node to link, or press Cancel link.
              </span>
            )}
          </div>

          {adding && canEdit && (
            <AddNodeForm
              siteId={siteId}
              onDone={async (created) => {
                setAdding(false);
                if (created) await load();
              }}
              onError={setError}
            />
          )}

          <div className="overflow-auto rounded-md border border-border bg-surface-sunken">
            {graph && graph.nodes.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-ink-muted">
                Nothing on this diagram yet.
                {graph.unifiBound
                  ? ' The next UniFi sync will seed it from the controller.'
                  : ' Add a node, or bind a UniFi mapping to this site to seed it automatically.'}
              </p>
            ) : (
              <svg
                ref={surface}
                width={extent.w}
                height={extent.h}
                className="block touch-none select-none"
                onPointerMove={onPointerMove}
                onPointerUp={() => void onPointerUp()}
                onPointerLeave={() => void onPointerUp()}
              >
                {/* Lines first, so a box always sits on top of its own cables. */}
                {graph?.links.map((link) => {
                  const a = positions.get(link.fromNodeId);
                  const b = positions.get(link.toNodeId);
                  if (!a || !b) return null;
                  const x1 = a.x + BOX.w / 2;
                  const y1 = a.y + BOX.h / 2;
                  const x2 = b.x + BOX.w / 2;
                  const y2 = b.y + BOX.h / 2;
                  const active = selected === link.id;
                  return (
                    <g key={link.id} onClick={() => setSelected(active ? null : link.id)}>
                      {/* A 12px transparent stroke under the visible one: a
                          1px line is a cruel click target. */}
                      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
                      <line
                        x1={x1} y1={y1} x2={x2} y2={y2}
                        className={active ? 'stroke-brand' : 'stroke-border-strong'}
                        strokeWidth={active ? 3 : 2}
                        strokeDasharray={link.source === 'unifi_sync' ? undefined : '6 4'}
                      />
                      {link.label && (
                        <text
                          x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6}
                          textAnchor="middle"
                          className="fill-ink-faint text-[10px]"
                        >
                          {link.label}
                        </text>
                      )}
                    </g>
                  );
                })}

                {graph?.nodes.map((node) => {
                  const at = positions.get(node.id);
                  if (!at) return null;
                  const Icon = ICONS[node.deviceType] ?? Network;
                  const active = selected === node.id;
                  const linkSource = linkingFrom === node.id;
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${at.x},${at.y})`}
                      className={canEdit ? 'cursor-grab' : 'cursor-pointer'}
                      onPointerDown={(e) => onNodePointerDown(e, node)}
                      onClick={() => void onNodeClick(node)}
                    >
                      <rect
                        width={BOX.w} height={BOX.h} rx={8}
                        className={
                          linkSource ? 'fill-surface-raised stroke-brand'
                            : active ? 'fill-surface-raised stroke-brand'
                              : 'fill-surface-raised stroke-border-strong'
                        }
                        strokeWidth={active || linkSource ? 2 : 1}
                      />
                      <foreignObject x={8} y={8} width={BOX.w - 16} height={BOX.h - 16}>
                        <div className="flex h-full items-center gap-2 overflow-hidden">
                          <Icon className="size-4 shrink-0 text-ink-faint" />
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-medium text-ink">
                              {node.label}
                            </span>
                            <span className="block truncate text-[10px] text-ink-faint">
                              {node.ipAddress ?? node.subnet ?? '—'}
                            </span>
                          </span>
                        </div>
                      </foreignObject>
                    </g>
                  );
                })}
              </svg>
            )}
          </div>

          {(selectedNode || selectedLink) && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2">
              <span className="text-sm font-medium text-ink">
                {selectedNode ? selectedNode.label : selectedLink?.label ?? 'Link'}
              </span>
              {selectedNode?.source === 'unifi_sync' && <Badge tone="neutral">From UniFi</Badge>}
              {selectedLink?.source === 'unifi_sync' && <Badge tone="neutral">From UniFi</Badge>}

              <span className="ml-auto flex items-center gap-2">
                {selectedNode?.assetNodeId && (
                  <Button size="sm" variant="link" onClick={() => openAsset(selectedNode)}>
                    Open asset
                  </Button>
                )}
                {canEdit && selectedNode && (
                  <Button
                    size="sm" variant="secondary"
                    onClick={() => { setLinkingFrom(selectedNode.id); setSelected(null); }}
                  >
                    Link from here
                  </Button>
                )}
                {canEdit && (
                  <Button
                    size="sm" variant="danger"
                    onClick={() => {
                      if (selectedNode) return void removeNode(selectedNode);
                      if (selectedLink) return void removeLink(selectedLink);
                    }}
                  >
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                  <X className="size-4" />
                </Button>
              </span>
            </div>
          )}

          <FieldHint>
            Solid lines come from the UniFi sync; dashed lines were drawn by hand.
            A node positioned here is never moved by a sync.
          </FieldHint>
        </div>
      </Modal>
    </>
  );
}

/** The add-a-box form. Inline rather than a second modal stacked on the first. */
function AddNodeForm({
  siteId, onDone, onError,
}: {
  siteId: string;
  onDone: (created: boolean) => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [label, setLabel] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [subnet, setSubnet] = useState('');
  const [deviceType, setDeviceType] = useState<DeviceType>('generic');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!label.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const response = await fetch(`/api/sites/${siteId}/topology/nodes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          deviceType,
          ...(ipAddress.trim() ? { ipAddress: ipAddress.trim() } : {}),
          ...(subnet.trim() ? { subnet: subnet.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        onError(payload.error?.message ?? 'The node could not be added.');
        await onDone(false);
        return;
      }
      await onDone(true);
    } catch {
      onError('The request failed. Check your connection and retry.');
      await onDone(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3 rounded-md border border-border bg-surface-raised p-3 sm:grid-cols-4">
      <div className="sm:col-span-2">
        <Label htmlFor="topology-label">Label</Label>
        <Input
          id="topology-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="ISP handoff"
          maxLength={120}
        />
      </div>
      <div>
        <Label htmlFor="topology-type">Type</Label>
        <Select
          id="topology-type"
          value={deviceType}
          onChange={(e) => setDeviceType(e.target.value as DeviceType)}
        >
          {DEVICE_TYPES.map(([value, text]) => (
            <option key={value} value={value}>{text}</option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="topology-ip">IP address</Label>
        <Input
          id="topology-ip"
          value={ipAddress}
          onChange={(e) => setIpAddress(e.target.value)}
          placeholder="10.0.0.1"
          maxLength={64}
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="topology-subnet">Subnet</Label>
        <Input
          id="topology-subnet"
          value={subnet}
          onChange={(e) => setSubnet(e.target.value)}
          placeholder="10.0.0.0/24 — VLAN 20"
          maxLength={64}
        />
      </div>
      <div className="flex items-end gap-2 sm:col-span-2">
        <Button size="sm" variant="primary" onClick={() => void submit()} disabled={busy || !label.trim()}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onDone(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
