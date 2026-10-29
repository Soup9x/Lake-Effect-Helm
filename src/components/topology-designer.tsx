'use client';

/**
 * A network diagram, drawn full width on its own page (0880).
 *
 * A BOX IS A CONFIGURATION OR A LABEL. "Use an existing configuration" picks
 * one of the client's configurations: the box is drawn with its name, primary
 * IP and a matching shape, and keeps showing the configuration's CURRENT name
 * and IP (the server joins them on read), and clicking it opens it. "Something
 * else" is a typed label, for the ISP handoff or a patch panel with no entry.
 * "Add this location's configurations" drops in every configuration at the
 * diagram's location that is not on the diagram yet.
 *
 * WHY SVG AND NOT A LIBRARY. The canvas draws boxes and straight lines and lets
 * you drag a box. That is a few hundred lines of pointer handling against an
 * SVG, and the alternative — react-flow or d3 — is a dependency in the process
 * that holds decrypted client credentials, for a feature that does not need a
 * force simulation. If the diagram ever wants orthogonal routing or nested
 * groups, that is the moment to reconsider, not before.
 *
 * EDITING ((1190)). Right-click a box or a line, or use the ⋯ on a box, for its
 * menu. Drag from the dot on a box's right edge to another box to link them.
 * A line has a style (solid, dashed, dotted), an arrow (none, one end, both)
 * and a colour; so does a box, a colour. While a box is dragged, smart guides
 * snap it into line with the others — horizontally, vertically or on a 45°
 * diagonal — and Alt held down turns the snapping off for that drag. The
 * canvas fills the page's width, the corner grip drags it bigger (and that
 * size is saved on the diagram), and Full screen gives it the whole window.
 *
 * WHAT IS PERSISTED AND WHAT IS NOT.
 *
 * A drag writes pos_x/pos_y immediately, on pointer-up, and nothing else. The
 * auto-layout that places a node which has never been positioned is display
 * only: it is recomputed on every load and never written back. A node whose
 * position is NULL has genuinely never been placed, and writing a synthetic
 * one on first render would throw that distinction away for nothing. Zoom,
 * the grid and full screen are this viewer's, and are not saved.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRightLeft, ExternalLink, Grid3x3, Layers, Link2, Loader2, Magnet, Maximize2, Minimize2,
  Network, Pencil, Plus, RefreshCw, Router, Server, Shield, Trash2, Wifi, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label, Select } from './ui/field';
import { apiFetch, type ApiRequest } from '@/lib/ui/api';
import {
  ARROWS, CANVAS_LIMITS, DIAGRAM_COLORS, LINE_STYLES,
  type Arrow, type DiagramColor, type LineStyle,
} from '@/lib/topology/style';
import { cn } from '@/lib/ui/cn';

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
  color: DiagramColor | null;
}

interface TopologyLink {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label: string | null;
  lineStyle: LineStyle;
  arrow: Arrow;
  color: DiagramColor | null;
}

interface Configuration {
  id: string;
  name: string;
  primaryIp: string | null;
  shape: DeviceType;
  siteId: string | null;
}

interface Graph {
  diagram: {
    id: string; name: string; siteId: string | null; siteName: string | null;
    canvasWidth: number | null; canvasHeight: number | null;
  };
  nodes: TopologyNode[];
  links: TopologyLink[];
  /** The client's configurations, for the picker. */
  configurations: Configuration[];
}

type Point = { x: number; y: number };
type Segment = { x1: number; y1: number; x2: number; y2: number };

/** Box geometry. Shared by the renderer and the hit testing, so they agree. */
const BOX = { w: 168, h: 56, gapX: 208, gapY: 104, perRow: 4, originX: 40, originY: 36 };
/** The grid, when it is on: drawn as dots, and a drag snaps to it. */
const GRID = 20;
/** How close, in canvas pixels, a box has to come before a guide catches it. */
const SNAP = 6;
/** The canvas's height until somebody drags it taller. */
const DEFAULT_HEIGHT = 480;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2] as const;

/**
 * One colour per palette name. Mid-lightness, so a line or an outline in it
 * reads on the light surface and the dark one; a box's fill is the same colour
 * mixed thinly into the surface, so it follows the theme on its own.
 */
const PALETTE: Record<DiagramColor, string> = {
  slate: 'oklch(58% 0.03 250)',
  blue: 'oklch(60% 0.15 250)',
  green: 'oklch(62% 0.15 155)',
  amber: 'oklch(72% 0.15 75)',
  red: 'oklch(60% 0.19 27)',
  purple: 'oklch(58% 0.17 300)',
};
const COLOR_NAMES: Record<DiagramColor, string> = {
  slate: 'Grey', blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', purple: 'Purple',
};
/** The smart guides: magenta, the colour people know them by. */
const GUIDE = 'oklch(62% 0.24 340)';

const DASHES: Record<LineStyle, string | undefined> = {
  solid: undefined,
  dashed: '9 6',
  // A near-zero dash with a round cap is a dot.
  dotted: '0.1 6',
};
const STYLE_NAMES: Record<LineStyle, string> = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' };
const ARROW_NAMES: Record<Arrow, string> = {
  none: 'No arrow', end: 'Arrow at the end', start: 'Arrow at the start', both: 'Arrows at both ends',
};

/**
 * Where to draw a node that has never been positioned.
 *
 * A grid in creation order: deterministic, so the diagram does not rearrange
 * itself between two people looking at it, and good enough that the first drag
 * is an adjustment rather than a rescue. Not written back — see the header.
 */
function layout(nodes: TopologyNode[]): Map<string, Point> {
  const placed = new Map<string, Point>();
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

const centre = (at: Point): Point => ({ x: at.x + BOX.w / 2, y: at.y + BOX.h / 2 });

/** Where the line from a box's centre toward a point leaves the box. */
function edgePoint(c: Point, toward: Point): Point {
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : BOX.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : BOX.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** `p` moved `by` pixels toward `toward`. */
function towards(p: Point, toward: Point, by: number): Point {
  const dx = toward.x - p.x;
  const dy = toward.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: p.x + (dx / len) * by, y: p.y + (dy / len) * by };
}

/** An arrowhead with its tip at `tip`, pointing away from `from`. */
function arrowHead(tip: Point, from: Point): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip.x - ux * 11;
  const by = tip.y - uy * 11;
  return `${tip.x},${tip.y} ${bx - uy * 5.5},${by + ux * 5.5} ${bx + uy * 5.5},${by - ux * 5.5}`;
}

/**
 * Smart guides: where a box being dragged to `raw` should land, and the lines
 * that show why.
 *
 * Every box is the same size, so lining up left edges also lines up centres
 * and right edges; the candidates that matter are centre-on-centre and
 * edge-against-edge (left of one on the right of the other). The nearest one
 * within SNAP wins, per axis. Only when neither axis caught does the diagonal
 * get a turn: if the box sits close to 45° from another, it is pulled onto
 * that diagonal exactly. The grid, when on, catches whatever axis nothing else
 * did.
 */
function snapPosition(raw: Point, others: readonly Point[], grid: boolean): { at: Point; guides: Segment[] } {
  const xs = (o: Point) => [o.x - raw.x, o.x + BOX.w - raw.x, o.x - (raw.x + BOX.w)];
  const ys = (o: Point) => [o.y - raw.y, o.y + BOX.h - raw.y, o.y - (raw.y + BOX.h)];
  let dx: number | null = null;
  let dy: number | null = null;
  for (const o of others) {
    for (const d of xs(o)) {
      if (Math.abs(d) <= SNAP && (dx === null || Math.abs(d) < Math.abs(dx))) dx = d;
    }
    for (const d of ys(o)) {
      if (Math.abs(d) <= SNAP && (dy === null || Math.abs(d) < Math.abs(dy))) dy = d;
    }
  }

  if (dx === null && dy === null) {
    const c = centre(raw);
    let best: { to: Point; from: Point; dist: number } | null = null;
    for (const o of others) {
      const oc = centre(o);
      const vx = c.x - oc.x;
      const vy = c.y - oc.y;
      const ax = Math.abs(vx);
      const ay = Math.abs(vy);
      // Too close to mean "diagonal from it", or not near 45°.
      if (ax < BOX.h || Math.abs(ax - ay) > SNAP * 2) continue;
      const d = (ax + ay) / 2;
      const to = { x: oc.x + Math.sign(vx) * d, y: oc.y + Math.sign(vy) * d };
      const dist = Math.hypot(to.x - c.x, to.y - c.y);
      if (!best || dist < best.dist) best = { to, from: oc, dist };
    }
    if (best) {
      // From the edge of the box it lines up with, to a little past this one.
      const start = edgePoint(best.from, best.to);
      const past = towards(best.to, best.from, -48);
      return {
        at: { x: best.to.x - BOX.w / 2, y: best.to.y - BOX.h / 2 },
        guides: [{ x1: start.x, y1: start.y, x2: past.x, y2: past.y }],
      };
    }
  }

  const at = {
    x: dx !== null ? raw.x + dx : grid ? Math.round(raw.x / GRID) * GRID : raw.x,
    y: dy !== null ? raw.y + dy : grid ? Math.round(raw.y / GRID) * GRID : raw.y,
  };

  // One guide per box and axis that now lines up: through the centres when the
  // centres agree, otherwise along the edges that touch.
  const guides: Segment[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  for (const o of others) {
    const top = Math.min(at.y, o.y) - 10;
    const bottom = Math.max(at.y, o.y) + BOX.h + 10;
    const gx = dx === null ? null
      : near(at.x, o.x) ? at.x + BOX.w / 2
        : near(at.x, o.x + BOX.w) ? at.x
          : near(at.x + BOX.w, o.x) ? o.x : null;
    if (gx !== null) guides.push({ x1: gx, y1: top, x2: gx, y2: bottom });

    const left = Math.min(at.x, o.x) - 10;
    const right = Math.max(at.x, o.x) + BOX.w + 10;
    const gy = dy === null ? null
      : near(at.y, o.y) ? at.y + BOX.h / 2
        : near(at.y, o.y + BOX.h) ? at.y
          : near(at.y + BOX.h, o.y) ? o.y : null;
    if (gy !== null) guides.push({ x1: left, y1: gy, x2: right, y2: gy });
  }
  return { at, guides };
}

/** True when a key press belongs to a text field rather than the canvas. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

type Menu =
  | { kind: 'node'; id: string; left: number; top: number }
  | { kind: 'link'; id: string; left: number; top: number }
  | { kind: 'canvas'; at: Point; left: number; top: number };

export interface TopologyDesignerProps {
  diagramId: string;
  diagramName: string;
  /** False for a viewer: the canvas still renders, nothing is draggable. */
  canEdit: boolean;
}

export function TopologyDesigner({ diagramId, diagramName, canEdit }: TopologyDesignerProps) {
  const router = useRouter();
  const base = `/api/diagrams/${diagramId}/topology`;
  const [graph, setGraph] = useState<Graph | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Positions being rendered, including drags in flight. */
  const [positions, setPositions] = useState<Map<string, Point>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  /** The node a link is being drawn from, if any: by "Link from here", or by dragging the dot. */
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);
  const [linkDragging, setLinkDragging] = useState(false);
  /** The pointer, in canvas coordinates, while a link is being drawn. */
  const [cursor, setCursor] = useState<Point | null>(null);
  const [adding, setAdding] = useState<{ at?: Point } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [guides, setGuides] = useState<Segment[]>([]);

  const [zoom, setZoom] = useState(1);
  const [snapOn, setSnapOn] = useState(true);
  const [gridOn, setGridOn] = useState(false);
  const [full, setFull] = useState(false);
  /** The canvas size while its corner is being dragged. */
  const [sizeDraft, setSizeDraft] = useState<{ w: number; h: number } | null>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const surface = useRef<SVGSVGElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean; x0: number; y0: number } | null>(null);
  const linkDrag = useRef<{ from: string; moved: boolean } | null>(null);
  const resize = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<Graph>(base);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const next = result.value;
      setGraph(next);
      setPositions(layout(next.nodes));
    } finally {
      setBusy(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The scroller's size, so the canvas can fill it until somebody sizes it. */
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** One place that turns a failed write into a message, since every action writes. */
  const send = useCallback(async (path: string, request: ApiRequest): Promise<boolean> => {
    const result = await apiFetch(path, request);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    return true;
  }, []);

  const nodeById = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph]);
  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const selectedLink = useMemo(
    () => graph?.links.find((l) => l.id === selected) ?? null,
    [graph, selected],
  );

  // -- geometry --------------------------------------------------------------
  const pointFor = (event: { clientX: number; clientY: number }): Point => {
    const rect = surface.current?.getBoundingClientRect();
    return {
      x: (event.clientX - (rect?.left ?? 0)) / zoom,
      y: (event.clientY - (rect?.top ?? 0)) / zoom,
    };
  };

  /** The topmost box under a canvas point, if any. */
  const nodeAt = (p: Point): string | null => {
    const nodes = graph?.nodes ?? [];
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const n = nodes[i];
      const at = n && positions.get(n.id);
      if (n && at && p.x >= at.x && p.x <= at.x + BOX.w && p.y >= at.y && p.y <= at.y + BOX.h) return n.id;
    }
    return null;
  };

  /** How far the boxes reach: the canvas is never smaller than this. */
  const reach = useMemo(() => {
    let w = 0;
    let h = 0;
    for (const { x, y } of positions.values()) {
      w = Math.max(w, x + BOX.w + 40);
      h = Math.max(h, y + BOX.h + 40);
    }
    return { w, h };
  }, [positions]);

  /**
   * The canvas size, in canvas pixels. Somebody's saved size if there is one,
   * otherwise the width of the page (and in full screen, its height too); never
   * smaller than the boxes reach.
   */
  const fillW = Math.max(720, Math.floor(viewport.w / zoom) - 2);
  const fillH = full ? Math.max(DEFAULT_HEIGHT, Math.floor(viewport.h / zoom) - 2) : DEFAULT_HEIGHT;
  const savedW = graph?.diagram.canvasWidth ?? null;
  const savedH = graph?.diagram.canvasHeight ?? null;
  const extent = {
    w: Math.max(sizeDraft?.w ?? savedW ?? fillW, reach.w),
    h: Math.max(sizeDraft?.h ?? savedH ?? fillH, reach.h),
  };

  // -- dragging --------------------------------------------------------------
  const onNodePointerDown = (event: React.PointerEvent, node: TopologyNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setMenu(null);
    if (linkingFrom !== null) return; // the click that follows picks the far end
    setSelected(node.id);
    if (!canEdit) return;
    const at = positions.get(node.id);
    if (!at) return;
    const p = pointFor(event);
    drag.current = { id: node.id, dx: p.x - at.x, dy: p.y - at.y, moved: false, x0: event.clientX, y0: event.clientY };
    surface.current?.setPointerCapture?.(event.pointerId);
  };

  /** The dot on a box's right edge: drag it to another box, or click it to pick one. */
  const onHandlePointerDown = (event: React.PointerEvent, node: TopologyNode) => {
    if (event.button !== 0 || !canEdit) return;
    event.stopPropagation();
    setMenu(null);
    linkDrag.current = { from: node.id, moved: false };
    setLinkingFrom(node.id);
    setLinkDragging(true);
    setCursor(pointFor(event));
    surface.current?.setPointerCapture?.(event.pointerId);
  };

  const onResizePointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || !canEdit) return;
    event.stopPropagation();
    resize.current = { x: event.clientX, y: event.clientY, w: extent.w, h: extent.h };
    surface.current?.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const r = resize.current;
    if (r) {
      setSizeDraft({
        w: Math.min(CANVAS_LIMITS.max, Math.max(CANVAS_LIMITS.minW, r.w + (event.clientX - r.x) / zoom)),
        h: Math.min(CANVAS_LIMITS.max, Math.max(CANVAS_LIMITS.minH, r.h + (event.clientY - r.y) / zoom)),
      });
      return;
    }

    const p = pointFor(event);
    if (linkingFrom !== null) {
      if (linkDrag.current) linkDrag.current.moved = true;
      setCursor(p);
      return;
    }

    const d = drag.current;
    if (!d) return;
    // A few pixels of wobble on a click is not a drag.
    if (!d.moved && Math.hypot(event.clientX - d.x0, event.clientY - d.y0) < 3) return;
    d.moved = true;
    const raw = { x: Math.max(0, p.x - d.dx), y: Math.max(0, p.y - d.dy) };
    let at = raw;
    let lines: Segment[] = [];
    if (snapOn && !event.altKey) {
      const others: Point[] = [];
      for (const [id, pos] of positions) if (id !== d.id) others.push(pos);
      ({ at, guides: lines } = snapPosition(raw, others, gridOn));
      at = { x: Math.max(0, at.x), y: Math.max(0, at.y) };
    } else if (gridOn && !event.altKey) {
      at = { x: Math.round(raw.x / GRID) * GRID, y: Math.round(raw.y / GRID) * GRID };
    }
    setGuides(lines);
    setPositions((prev) => {
      const next = new Map(prev);
      next.set(d.id, at);
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
  const onPointerUp = async (event: React.PointerEvent) => {
    if (resize.current) {
      resize.current = null;
      const draft = sizeDraft;
      if (!draft) return;
      await saveCanvasSize({ w: Math.round(draft.w), h: Math.round(draft.h) });
      return;
    }

    const l = linkDrag.current;
    if (l) {
      linkDrag.current = null;
      setLinkDragging(false);
      // A click on the dot leaves "pick the second box" running; a drag ends here.
      if (!l.moved) return;
      const target = nodeAt(pointFor(event));
      setLinkingFrom(null);
      setCursor(null);
      if (target && target !== l.from) await createLink(l.from, target);
      return;
    }

    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (!d?.moved) return;

    const at = positionsRef.current.get(d.id);
    if (!at) return;
    await send(`${base}/nodes/${d.id}`, {
      method: 'PATCH',
      json: { posX: Math.round(at.x), posY: Math.round(at.y) },
    });
  };

  // -- actions ---------------------------------------------------------------
  const createLink = async (from: string, to: string) => {
    if (await send(`${base}/links`, { json: { fromNodeId: from, toNodeId: to } })) await load();
  };

  const onNodeClick = async (node: TopologyNode) => {
    if (linkingFrom === null || linkDrag.current) return;
    const from = linkingFrom;
    setLinkingFrom(null);
    setCursor(null);
    if (from !== node.id) await createLink(from, node.id);
  };

  const startLink = (node: TopologyNode) => {
    setMenu(null);
    setSelected(null);
    setLinkingFrom(node.id);
    const at = positions.get(node.id);
    if (at) setCursor({ x: at.x + BOX.w + 40, y: at.y + BOX.h / 2 });
  };

  const cancelLink = () => {
    linkDrag.current = null;
    setLinkDragging(false);
    setLinkingFrom(null);
    setCursor(null);
  };

  const removeNode = async (node: TopologyNode) => {
    setMenu(null);
    if (await send(`${base}/nodes/${node.id}`, { method: 'DELETE' })) {
      setSelected(null);
      await load();
    }
  };

  const removeLink = async (link: TopologyLink) => {
    setMenu(null);
    if (await send(`${base}/links/${link.id}`, { method: 'DELETE' })) {
      setSelected(null);
      await load();
    }
  };

  /** Change a line in place, then write it; a refused write reloads the truth. */
  const patchLink = async (
    link: TopologyLink,
    change: Partial<Pick<TopologyLink, 'label' | 'lineStyle' | 'arrow' | 'color'>> & { reverse?: true },
  ) => {
    setGraph((g) => g && {
      ...g,
      links: g.links.map((l) => {
        if (l.id !== link.id) return l;
        const { reverse, ...rest } = change;
        const next = { ...l, ...rest };
        return reverse ? { ...next, fromNodeId: l.toNodeId, toNodeId: l.fromNodeId } : next;
      }),
    });
    if (!(await send(`${base}/links/${link.id}`, { method: 'PATCH', json: change }))) await load();
  };

  const patchNodeColor = async (node: TopologyNode, color: DiagramColor | null) => {
    setGraph((g) => g && { ...g, nodes: g.nodes.map((n) => (n.id === node.id ? { ...n, color } : n)) });
    if (!(await send(`${base}/nodes/${node.id}`, { method: 'PATCH', json: { color } }))) await load();
  };

  const saveCanvasSize = async (size: { w: number; h: number } | null) => {
    setGraph((g) => g && {
      ...g,
      diagram: { ...g.diagram, canvasWidth: size?.w ?? null, canvasHeight: size?.h ?? null },
    });
    setSizeDraft(null);
    const ok = await send(`/api/diagrams/${diagramId}`, {
      method: 'PATCH',
      json: { canvasWidth: size?.w ?? null, canvasHeight: size?.h ?? null },
    });
    if (!ok) await load();
  };

  const openAsset = (node: TopologyNode) => {
    if (!node.assetNodeId) return;
    router.push(`/assets/${node.assetNodeId}`);
  };

  /** Open a menu where the pointer is, kept inside the window. */
  const openMenu = (event: { clientX: number; clientY: number }, m: Menu['kind'], id?: string) => {
    const left = Math.min(event.clientX, window.innerWidth - 248);
    const top = Math.min(event.clientY, window.innerHeight - (m === 'link' ? 340 : 240));
    if (m === 'canvas') {
      setMenu({ kind: 'canvas', at: pointFor(event), left, top });
    } else if (id) {
      setMenu({ kind: m, id, left, top });
      setSelected(id);
    }
  };

  /** Configurations not on the diagram yet: what the picker and the bulk add offer. */
  const unplaced = useMemo(() => {
    const placed = new Set(graph?.nodes.map((n) => n.assetNodeId).filter(Boolean));
    return (graph?.configurations ?? []).filter((c) => !placed.has(c.id));
  }, [graph]);
  const atThisLocation = useMemo(
    () => (graph?.diagram.siteId ? unplaced.filter((c) => c.siteId === graph.diagram.siteId) : []),
    [unplaced, graph],
  );

  /** One box per configuration at the location, then one reload. */
  const addLocation = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const c of atThisLocation) {
        const ok = await send(`${base}/nodes`, {
          json: {
            assetNodeId: c.id, label: c.name.slice(0, 120), deviceType: c.shape,
            ...(c.primaryIp ? { ipAddress: c.primaryIp } : {}),
          },
        });
        if (!ok) break;
      }
    } finally {
      setBusy(false);
    }
    await load();
  };

  // -- keyboard --------------------------------------------------------------
  // Escape backs out of whatever is open, one thing at a time. The arrow keys
  // nudge the selected box (Shift for ten), saved once the keys go quiet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (menu) setMenu(null);
        else if (linkingFrom) cancelLink();
        else if (adding) setAdding(null);
        else if (selected) setSelected(null);
        else if (full) setFull(false);
        return;
      }
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!step || !canEdit || !selected || typing(event.target)) return;
      const at = positionsRef.current.get(selected);
      if (!at || !nodeById.has(selected)) return;
      event.preventDefault();
      const by = event.shiftKey ? 10 : 1;
      const id = selected;
      setPositions((prev) => {
        const next = new Map(prev);
        next.set(id, { x: Math.max(0, at.x + (step[0] ?? 0) * by), y: Math.max(0, at.y + (step[1] ?? 0) * by) });
        return next;
      });
      if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
      nudgeTimer.current = setTimeout(() => {
        const now = positionsRef.current.get(id);
        if (now) {
          void send(`${base}/nodes/${id}`, {
            method: 'PATCH', json: { posX: Math.round(now.x), posY: Math.round(now.y) },
          });
        }
      }, 500);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // A menu closes on a press anywhere outside it.
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.('[data-diagram-menu]')) setMenu(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  // Full screen: the page behind should not scroll.
  useEffect(() => {
    if (!full) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [full]);

  const zoomBy = (dir: 1 | -1) => {
    const i = (ZOOMS as readonly number[]).indexOf(zoom);
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i === -1 ? 3 : i) + dir))];
    if (next) setZoom(next);
  };

  const menuNode = menu?.kind === 'node' ? nodeById.get(menu.id) ?? null : null;
  const menuLink = menu?.kind === 'link' ? graph?.links.find((l) => l.id === menu.id) ?? null : null;
  const sourceAt = linkingFrom ? positions.get(linkingFrom) : undefined;
  const linkTarget = linkingFrom && cursor ? nodeAt(cursor) : null;

  return (
    <Card className={full ? 'fixed inset-0 z-[60] flex flex-col rounded-none border-0' : undefined}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Network className="size-4 text-ink-faint" aria-hidden /> {full ? diagramName : 'Diagram'}
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setFull((v) => !v)}>
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          {full ? 'Exit full screen' : 'Full screen'}
        </Button>
      </CardHeader>
      <CardContent className={full ? 'flex min-h-0 flex-1 flex-col' : undefined}>
        <div className={cn('space-y-3', full && 'flex min-h-0 flex-1 flex-col')}>
          {error && (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setAdding((v) => (v ? null : {}))}>
                  <Plus className="size-4" />
                  Add a box
                </Button>
                {atThisLocation.length > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => void addLocation()} disabled={busy}>
                    <Layers className="size-4" />
                    Add {graph?.diagram.siteName ?? 'this location'}’s configurations ({atThisLocation.length})
                  </Button>
                )}
                {linkingFrom && !linkDragging && (
                  <Button size="sm" variant="primary" onClick={cancelLink}>
                    <X className="size-4" />
                    Cancel link
                  </Button>
                )}
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                <Toggle on={snapOn} onClick={() => setSnapOn((v) => !v)} title="Snap boxes into line with each other while dragging (hold Alt to skip)">
                  <Magnet className="size-4" /> Guides
                </Toggle>
                <Toggle on={gridOn} onClick={() => setGridOn((v) => !v)} title="Show a grid and snap to it">
                  <Grid3x3 className="size-4" /> Grid
                </Toggle>
              </>
            )}
            <span className="flex items-center rounded-md border border-border">
              <Button size="sm" variant="ghost" className="px-2" onClick={() => zoomBy(-1)} disabled={zoom === ZOOMS[0]} aria-label="Zoom out">
                <ZoomOut className="size-4" />
              </Button>
              <button
                type="button"
                className="w-12 text-center text-xs tabular-nums text-ink-muted hover:text-ink"
                onClick={() => setZoom(1)}
                title="Back to 100%"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button size="sm" variant="ghost" className="px-2" onClick={() => zoomBy(1)} disabled={zoom === ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in">
                <ZoomIn className="size-4" />
              </Button>
            </span>
            {canEdit && (savedW !== null || savedH !== null) && (
              <Button size="sm" variant="ghost" onClick={() => void saveCanvasSize(null)} title="Go back to filling the page">
                Reset canvas size
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh
            </Button>
            {linkingFrom && !linkDragging && (
              <span className="text-xs text-ink-muted">
                Click the box to link to, or press Esc.
              </span>
            )}
          </div>

          {adding && canEdit && (
            <AddNodeForm
              base={base}
              configurations={unplaced}
              at={adding.at}
              onDone={async (created) => {
                setAdding(null);
                if (created) await load();
              }}
              onError={setError}
            />
          )}

          <div
            ref={scroller}
            className={cn(
              'overflow-auto rounded-md border border-border bg-surface-sunken',
              full && 'min-h-0 flex-1',
            )}
            onScroll={() => setMenu(null)}
          >
            {graph && (
              <svg
                ref={surface}
                width={extent.w * zoom}
                height={extent.h * zoom}
                viewBox={`0 0 ${extent.w} ${extent.h}`}
                role="img"
                aria-label={`Network diagram: ${diagramName}`}
                className="block touch-none select-none"
                onPointerMove={onPointerMove}
                onPointerUp={(e) => void onPointerUp(e)}
                onPointerCancel={(e) => void onPointerUp(e)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (canEdit) openMenu(e, 'canvas');
                }}
              >
                <defs>
                  <pattern id={`grid-${diagramId}`} width={GRID} height={GRID} patternUnits="userSpaceOnUse">
                    <circle cx={1} cy={1} r={1} className="fill-border-strong" />
                  </pattern>
                </defs>
                {/* The background: a press here clears the selection. */}
                <rect
                  width={extent.w} height={extent.h}
                  fill={gridOn ? `url(#grid-${diagramId})` : 'transparent'}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    setSelected(null);
                    setMenu(null);
                  }}
                />

                {graph.nodes.length === 0 && (
                  <text x={extent.w / 2} y={80} textAnchor="middle" className="fill-ink-muted text-sm">
                    Nothing on this diagram yet. Add a box — one of this client’s configurations, or anything else on the network.
                  </text>
                )}

                {/* Lines first, so a box always sits on top of its own cables. */}
                {graph.links.map((link) => {
                  const a = positions.get(link.fromNodeId);
                  const b = positions.get(link.toNodeId);
                  if (!a || !b) return null;
                  const ca = centre(a);
                  const cb = centre(b);
                  const pa = towards(edgePoint(ca, cb), cb, 2);
                  const pb = towards(edgePoint(cb, ca), ca, 2);
                  const atEnd = link.arrow === 'end' || link.arrow === 'both';
                  const atStart = link.arrow === 'start' || link.arrow === 'both';
                  const from = atStart ? towards(pa, pb, 9) : pa;
                  const to = atEnd ? towards(pb, pa, 9) : pb;
                  const active = selected === link.id;
                  const paint = active ? 'var(--color-brand)' : link.color ? PALETTE[link.color] : 'var(--color-ink-faint)';
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: a diagram edge; selection by pointer is the only editing offered, as the header says
                    <g
                      key={link.id}
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        setMenu(null);
                        setSelected(link.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openMenu(e, 'link', link.id);
                      }}
                    >
                      {/* A 14px transparent stroke under the visible one: a
                          2px line is a cruel click target. */}
                      <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="transparent" strokeWidth={14} />
                      <line
                        x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                        style={{ stroke: paint }}
                        strokeWidth={link.lineStyle === 'dotted' ? 3 : active ? 3 : 2}
                        strokeDasharray={DASHES[link.lineStyle]}
                        strokeLinecap={link.lineStyle === 'dotted' ? 'round' : 'butt'}
                      />
                      {atEnd && <polygon points={arrowHead(pb, pa)} style={{ fill: paint }} />}
                      {atStart && <polygon points={arrowHead(pa, pb)} style={{ fill: paint }} />}
                      {link.label && (
                        <text
                          x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2 - 6}
                          textAnchor="middle"
                          className="fill-ink-muted text-[11px]"
                          style={{
                            paintOrder: 'stroke', stroke: 'var(--color-surface-sunken)',
                            strokeWidth: 4, strokeLinejoin: 'round',
                          }}
                        >
                          {link.label}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* The line being drawn, from its box to the pointer. */}
                {sourceAt && cursor && (() => {
                  const c = centre(sourceAt);
                  const target = linkTarget && linkTarget !== linkingFrom ? positions.get(linkTarget) : undefined;
                  const end = target ? edgePoint(centre(target), c) : cursor;
                  const start = edgePoint(c, end);
                  return (
                    <line
                      x1={start.x} y1={start.y} x2={end.x} y2={end.y}
                      className="pointer-events-none stroke-brand"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                    />
                  );
                })()}

                {graph.nodes.map((node) => {
                  const at = positions.get(node.id);
                  if (!at) return null;
                  const Icon = ICONS[node.deviceType] ?? Network;
                  const active = selected === node.id;
                  const linkSource = linkingFrom === node.id;
                  const linkCandidate = linkingFrom !== null && !linkSource && (linkTarget === node.id || hovered === node.id);
                  const tint = node.color ? PALETTE[node.color] : null;
                  const showTools = canEdit && linkingFrom === null && (hovered === node.id || active);
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: a diagram node, dragged with the pointer; see the edge above
                    <g
                      key={node.id}
                      transform={`translate(${at.x},${at.y})`}
                      className={linkingFrom !== null ? 'cursor-crosshair' : canEdit ? 'cursor-grab' : 'cursor-pointer'}
                      onPointerDown={(e) => onNodePointerDown(e, node)}
                      onPointerEnter={() => setHovered(node.id)}
                      onPointerLeave={() => setHovered((h) => (h === node.id ? null : h))}
                      onClick={() => void onNodeClick(node)}
                      onDoubleClick={() => openAsset(node)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openMenu(e, 'node', node.id);
                      }}
                    >
                      {(active || linkSource || linkCandidate) && (
                        <rect
                          x={-4} y={-4} width={BOX.w + 8} height={BOX.h + 8} rx={11}
                          fill="none" className="stroke-brand" strokeWidth={2}
                          strokeDasharray={linkSource || linkCandidate ? '5 3' : undefined}
                        />
                      )}
                      <rect
                        width={BOX.w} height={BOX.h} rx={8}
                        style={{
                          fill: tint
                            ? `color-mix(in oklch, ${tint} 16%, var(--color-surface-raised))`
                            : 'var(--color-surface-raised)',
                          stroke: tint ?? 'var(--color-border-strong)',
                        }}
                        strokeWidth={tint ? 1.5 : 1}
                      />
                      <foreignObject x={8} y={8} width={BOX.w - 16} height={BOX.h - 16}>
                        <div className="flex h-full items-center gap-2 overflow-hidden">
                          <Icon
                            className={cn('size-4 shrink-0', !tint && 'text-ink-faint')}
                            style={tint ? { color: tint } : undefined}
                          />
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

                      {showTools && (
                        <>
                          {/* The ⋯: the same menu as a right-click, for whoever does not think to. */}
                          {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer affordance; the right-click menu and the bar below offer the same */}
                          <g
                            transform={`translate(${BOX.w - 26},${-9})`}
                            className="cursor-pointer"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              const r = (e.currentTarget as Element).getBoundingClientRect();
                              openMenu({ clientX: r.left, clientY: r.bottom + 4 }, 'node', node.id);
                            }}
                          >
                            <title>More</title>
                            <rect width={22} height={16} rx={8} className="fill-surface-raised stroke-border-strong" />
                            <circle cx={6} cy={8} r={1.5} className="fill-ink-muted" />
                            <circle cx={11} cy={8} r={1.5} className="fill-ink-muted" />
                            <circle cx={16} cy={8} r={1.5} className="fill-ink-muted" />
                          </g>
                          {/* The connector dot: drag it to another box, or click it and then click one. */}
                          <g className="cursor-crosshair" onPointerDown={(e) => onHandlePointerDown(e, node)}>
                            <title>Drag to another box to link them</title>
                            <circle cx={BOX.w} cy={BOX.h / 2} r={10} fill="transparent" />
                            <circle cx={BOX.w} cy={BOX.h / 2} r={5.5} className="fill-brand stroke-surface-raised" strokeWidth={2} />
                          </g>
                        </>
                      )}
                    </g>
                  );
                })}

                {/* Smart guides, over everything, while a box is dragged. */}
                {guides.map((g) => (
                  <line
                    key={`${g.x1},${g.y1},${g.x2},${g.y2}`}
                    {...g}
                    className="pointer-events-none"
                    style={{ stroke: GUIDE }}
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                ))}

                {canEdit && (
                  // biome-ignore lint/a11y/noStaticElementInteractions: the canvas's resize grip, a pointer affordance; Reset canvas size undoes it
                  <g
                    transform={`translate(${extent.w - 16},${extent.h - 16})`}
                    className="cursor-nwse-resize"
                    onPointerDown={onResizePointerDown}
                    onDoubleClick={() => void saveCanvasSize(null)}
                  >
                    <title>Drag to make the canvas bigger; double-click to reset</title>
                    <rect width={16} height={16} fill="transparent" />
                    <path d="M4 14 L14 4 M8 14 L14 8 M12 14 L14 12" className="stroke-ink-faint" strokeWidth={1.5} />
                  </g>
                )}
              </svg>
            )}
          </div>

          {(selectedNode || selectedLink) && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2">
              {selectedNode && (
                <>
                  <span className="text-sm font-medium text-ink">{selectedNode.label}</span>
                  {canEdit && (
                    <ColorPicker value={selectedNode.color} onChange={(c) => void patchNodeColor(selectedNode, c)} />
                  )}
                </>
              )}
              {selectedLink && (
                <>
                  <span className="text-sm font-medium text-ink">
                    {nodeById.get(selectedLink.fromNodeId)?.label ?? '?'} — {nodeById.get(selectedLink.toNodeId)?.label ?? '?'}
                  </span>
                  {canEdit && (
                    <>
                      <LinkLabelInput key={selectedLink.id} link={selectedLink} onSave={(label) => void patchLink(selectedLink, { label })} />
                      <StylePicker value={selectedLink.lineStyle} onChange={(lineStyle) => void patchLink(selectedLink, { lineStyle })} />
                      <ArrowPicker value={selectedLink.arrow} onChange={(arrow) => void patchLink(selectedLink, { arrow })} />
                      <ColorPicker value={selectedLink.color} onChange={(color) => void patchLink(selectedLink, { color })} />
                    </>
                  )}
                </>
              )}

              <span className="ml-auto flex items-center gap-2">
                {selectedNode?.assetNodeId && (
                  <Button size="sm" variant="link" onClick={() => openAsset(selectedNode)}>
                    Open entry
                  </Button>
                )}
                {canEdit && selectedNode && (
                  <Button size="sm" variant="secondary" onClick={() => startLink(selectedNode)}>
                    <Link2 className="size-4" />
                    Link from here
                  </Button>
                )}
                {canEdit && selectedLink && selectedLink.arrow !== 'none' && selectedLink.arrow !== 'both' && (
                  <Button size="sm" variant="secondary" onClick={() => void patchLink(selectedLink, { reverse: true })}>
                    <ArrowRightLeft className="size-4" />
                    Reverse
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
                <Button size="sm" variant="ghost" onClick={() => setSelected(null)} aria-label="Close">
                  <X className="size-4" />
                </Button>
              </span>
            </div>
          )}

          {!full && (
            <FieldHint>
              Drag a box to place it; guides line it up with the others, and its position is saved as soon as you let go.
              Right-click a box or a line (or use the ⋯ on a box) for its options, drag the blue dot on a box to another
              box to link them, and drag the canvas’s bottom-right corner to make it bigger. Separate from
              Dependencies, which record reliance rather than cabling.
            </FieldHint>
          )}
        </div>
      </CardContent>

      {menu && (
        <div
          data-diagram-menu
          role="menu"
          className="fixed z-[70] w-60 rounded-md border border-border bg-surface-raised p-1 text-sm shadow-lg"
          style={{ left: menu.left, top: menu.top }}
        >
          {menu.kind === 'canvas' && (
            <MenuItem onClick={() => { setAdding({ at: menu.at }); setMenu(null); }}>
              <Plus className="size-4" /> Add a box here
            </MenuItem>
          )}

          {menuNode && (
            <>
              <MenuHeading>{menuNode.label}</MenuHeading>
              {canEdit && (
                <MenuItem onClick={() => startLink(menuNode)}>
                  <Link2 className="size-4" /> Link from here
                </MenuItem>
              )}
              {menuNode.assetNodeId && (
                <MenuItem onClick={() => { setMenu(null); openAsset(menuNode); }}>
                  <ExternalLink className="size-4" /> Open entry
                </MenuItem>
              )}
              {canEdit && (
                <>
                  <MenuSection label="Colour">
                    <ColorPicker value={menuNode.color} onChange={(c) => void patchNodeColor(menuNode, c)} />
                  </MenuSection>
                  <MenuDivider />
                  <MenuItem danger onClick={() => void removeNode(menuNode)}>
                    <Trash2 className="size-4" /> Remove from diagram
                  </MenuItem>
                </>
              )}
            </>
          )}

          {menuLink && (
            <>
              <MenuHeading>
                {menuLink.label || `${nodeById.get(menuLink.fromNodeId)?.label ?? '?'} — ${nodeById.get(menuLink.toNodeId)?.label ?? '?'}`}
              </MenuHeading>
              {canEdit ? (
                <>
                  <MenuSection label="Line">
                    <StylePicker value={menuLink.lineStyle} onChange={(lineStyle) => void patchLink(menuLink, { lineStyle })} />
                  </MenuSection>
                  <MenuSection label="Arrows">
                    <ArrowPicker value={menuLink.arrow} onChange={(arrow) => void patchLink(menuLink, { arrow })} />
                  </MenuSection>
                  <MenuSection label="Colour">
                    <ColorPicker value={menuLink.color} onChange={(color) => void patchLink(menuLink, { color })} />
                  </MenuSection>
                  <MenuDivider />
                  {(menuLink.arrow === 'end' || menuLink.arrow === 'start') && (
                    <MenuItem onClick={() => { setMenu(null); void patchLink(menuLink, { reverse: true }); }}>
                      <ArrowRightLeft className="size-4" /> Reverse direction
                    </MenuItem>
                  )}
                  <MenuItem
                    onClick={() => {
                      setMenu(null);
                      requestAnimationFrame(() => document.getElementById('diagram-link-label')?.focus());
                    }}
                  >
                    <Pencil className="size-4" /> {menuLink.label ? 'Edit label' : 'Add a label'}
                  </MenuItem>
                  <MenuItem danger onClick={() => void removeLink(menuLink)}>
                    <Trash2 className="size-4" /> Remove line
                  </MenuItem>
                </>
              ) : (
                <p className="px-2 py-1.5 text-xs text-ink-muted">{STYLE_NAMES[menuLink.lineStyle]} line</p>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// -- small pieces --------------------------------------------------------------

function Toggle({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <Button size="sm" variant={on ? 'primary' : 'secondary'} onClick={onClick} title={title} aria-pressed={on}>
      {children}
    </Button>
  );
}

function MenuHeading({ children }: { children: ReactNode }) {
  return <p className="truncate px-2 pt-1.5 pb-1 text-xs font-semibold text-ink-muted">{children}</p>;
}

function MenuDivider() {
  return <div className="my-1 h-px bg-border" />;
}

function MenuSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span className="text-xs text-ink-muted">{label}</span>
      {children}
    </div>
  );
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-sunken',
        danger ? 'text-danger' : 'text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** A row of small square buttons, one pressed. */
function Segmented<T extends string>({
  options, value, onChange, label, render,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: (v: T) => string;
  render: (v: T) => ReactNode;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          title={label(o)}
          aria-label={label(o)}
          aria-pressed={o === value}
          onClick={() => onChange(o)}
          className={cn(
            'flex h-7 w-9 items-center justify-center border-r border-border last:border-r-0',
            o === value ? 'bg-brand-tint text-brand' : 'text-ink-muted hover:bg-surface-sunken',
          )}
        >
          {render(o)}
        </button>
      ))}
    </span>
  );
}

function StylePicker({ value, onChange }: { value: LineStyle; onChange: (v: LineStyle) => void }) {
  return (
    <Segmented
      options={LINE_STYLES}
      value={value}
      onChange={onChange}
      label={(s) => STYLE_NAMES[s]}
      render={(s) => (
        <svg width="22" height="8" aria-hidden>
          <line
            x1="2" y1="4" x2="20" y2="4" stroke="currentColor"
            strokeWidth={s === 'dotted' ? 2.5 : 2}
            strokeDasharray={s === 'dashed' ? '5 3' : s === 'dotted' ? '0.1 4' : undefined}
            strokeLinecap={s === 'dotted' ? 'round' : 'butt'}
          />
        </svg>
      )}
    />
  );
}

function ArrowPicker({ value, onChange }: { value: Arrow; onChange: (v: Arrow) => void }) {
  return (
    <Segmented
      options={ARROWS}
      value={value}
      onChange={onChange}
      label={(a) => ARROW_NAMES[a]}
      render={(a) => (
        <svg width="22" height="10" aria-hidden>
          <line
            x1={a === 'start' || a === 'both' ? 6 : 2} y1="5"
            x2={a === 'end' || a === 'both' ? 16 : 20} y2="5"
            stroke="currentColor" strokeWidth="2"
          />
          {(a === 'end' || a === 'both') && <polygon points="21,5 15,1.5 15,8.5" fill="currentColor" />}
          {(a === 'start' || a === 'both') && <polygon points="1,5 7,1.5 7,8.5" fill="currentColor" />}
        </svg>
      )}
    />
  );
}

/** The palette, plus "none" for the default. */
function ColorPicker({ value, onChange }: { value: DiagramColor | null; onChange: (v: DiagramColor | null) => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        title="Default"
        aria-label="Default colour"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={cn(
          'size-5 rounded-full border border-border-strong bg-surface-raised',
          value === null && 'ring-2 ring-brand ring-offset-1 ring-offset-surface-raised',
        )}
      />
      {DIAGRAM_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={COLOR_NAMES[c]}
          aria-label={COLOR_NAMES[c]}
          aria-pressed={value === c}
          onClick={() => onChange(c)}
          className={cn('size-5 rounded-full', value === c && 'ring-2 ring-brand ring-offset-1 ring-offset-surface-raised')}
          style={{ background: PALETTE[c] }}
        />
      ))}
    </span>
  );
}

/** A line's label, written when the field loses focus or Enter is pressed. */
function LinkLabelInput({ link, onSave }: { link: TopologyLink; onSave: (label: string | null) => void }) {
  const [value, setValue] = useState(link.label ?? '');
  const commit = () => {
    const next = value.trim();
    if (next !== (link.label ?? '')) onSave(next || null);
  };
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      placeholder="Label, e.g. Gi1/0/24"
      maxLength={80}
      className="h-8 w-44"
      id="diagram-link-label"
      aria-label="Line label"
    />
  );
}

/** The add-a-box form. Inline rather than a dialog stacked on the page. */
function AddNodeForm({
  base, configurations, at, onDone, onError,
}: {
  base: string;
  /** Where to put the box, when it was added from the canvas's right-click menu. */
  at?: Point | undefined;
  /** The client's configurations not on the diagram yet. */
  configurations: readonly Configuration[];
  onDone: (created: boolean) => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [mode, setMode] = useState<'configuration' | 'other'>(configurations.length > 0 ? 'configuration' : 'other');
  const [configurationId, setConfigurationId] = useState(configurations[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [subnet, setSubnet] = useState('');
  const [deviceType, setDeviceType] = useState<DeviceType>('generic');
  const [busy, setBusy] = useState(false);

  const chosen = configurations.find((c) => c.id === configurationId) ?? null;
  const ready = mode === 'configuration' ? chosen !== null : label.trim() !== '';

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    onError(null);
    try {
      const where = at ? { posX: Math.round(at.x), posY: Math.round(at.y) } : {};
      const json = mode === 'configuration' && chosen
        ? {
            ...where,
            assetNodeId: chosen.id,
            label: chosen.name.slice(0, 120),
            deviceType: chosen.shape,
            ...(chosen.primaryIp ? { ipAddress: chosen.primaryIp } : {}),
            ...(subnet.trim() ? { subnet: subnet.trim() } : {}),
          }
        : {
            ...where,
            label: label.trim(),
            deviceType,
            ...(ipAddress.trim() ? { ipAddress: ipAddress.trim() } : {}),
            ...(subnet.trim() ? { subnet: subnet.trim() } : {}),
          };
      const result = await apiFetch(`${base}/nodes`, { json });
      if (!result.ok) {
        onError(result.message);
        await onDone(false);
        return;
      }
      await onDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-raised p-3">
      <fieldset className="flex flex-wrap gap-4 text-sm" aria-label="What the box is">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="topology-mode"
            checked={mode === 'configuration'}
            onChange={() => setMode('configuration')}
            disabled={configurations.length === 0}
          />
          Use an existing configuration
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="topology-mode" checked={mode === 'other'} onChange={() => setMode('other')} />
          Something else
        </label>
      </fieldset>

      {mode === 'configuration' ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Label htmlFor="topology-configuration">Configuration</Label>
            <Select
              id="topology-configuration"
              value={configurationId}
              onChange={(e) => setConfigurationId(e.target.value)}
            >
              {configurations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.primaryIp ? ` — ${c.primaryIp}` : ''}
                </option>
              ))}
            </Select>
            <FieldHint>Its name and IP stay in step with the configuration.</FieldHint>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="topology-subnet">Note on the box</Label>
            <Input
              id="topology-subnet"
              value={subnet}
              onChange={(e) => setSubnet(e.target.value)}
              placeholder="Optional, e.g. core switch, rack 2"
              maxLength={64}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-4">
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
        </div>
      )}

      <div className="flex items-end gap-2">
        <Button size="sm" variant="primary" onClick={() => void submit()} disabled={busy || !ready}>
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
