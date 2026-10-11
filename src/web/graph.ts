// Small force-directed graph renderer (SVG, no dependencies) with pan / zoom.
// Zooming changes the viewBox; node radii, label sizes and stroke widths are rescaled so they keep their
// on-screen size, which is what lets zooming in pull overlapping labels apart.
import type { Graph } from '../shared/types.js';
import { h, svg } from './dom.js';

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const MAX_ZOOM = 20;
/** Node radius in screen pixels: least to most linked (diameter ratio 2). */
const R_MIN = 6;
const R_MAX = 12;
const LABEL_PX = 12;

/** Approximate on-screen width of a label (no layout pass): CJK and other wide characters ~1em, the rest ~0.6em. */
function labelWidthPx(label: string): number {
  let w = 0;
  for (const ch of label) w += ch.charCodeAt(0) > 0x2e7f ? LABEL_PX : LABEL_PX * 0.6;
  return w;
}

function layout(g: Graph, focus: string | undefined) {
  const n = g.nodes.length;
  // The canvas grows with the graph (constant area per node) instead of squeezing everything into one size.
  const W = Math.max(900, Math.sqrt(n) * 120);
  const H = Math.round((W * 2) / 3);
  const pos = new Map<string, P>();
  g.nodes.forEach((node, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, n);
    pos.set(node.id, { x: W / 2 + Math.cos(a) * W * 0.22, y: H / 2 + Math.sin(a) * H * 0.33, vx: 0, vy: 0 });
  });
  if (focus && pos.has(focus)) Object.assign(pos.get(focus)!, { x: W / 2, y: H / 2 });
  const edges = g.edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.6;
  const ps = [...pos.values()];
  for (let iter = 0; iter < 300; iter++) {
    const t = 1 - iter / 300;
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]!;
        const b = ps[j]!;
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const f = (k * k) / (dx * dx + dy * dy);
        a.vx += dx * f * 0.05;
        a.vy += dy * f * 0.05;
        b.vx -= dx * f * 0.05;
        b.vy -= dy * f * 0.05;
      }
    for (const e of edges) {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = ((d - k) / d) * (e.kind === 'tag' ? 0.02 : 0.05);
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const p of ps) {
      // Gravity instead of hard walls: clamping to the canvas piled nodes up along its edges. The view fits
      // whatever bounding box results, so positions may leave the nominal W x H.
      p.vx += (W / 2 - p.x) * 0.006;
      p.vy += (H / 2 - p.y) * 0.009;
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const max = 20 * t + 1;
      if (v > max) {
        p.vx = (p.vx / v) * max;
        p.vy = (p.vy / v) * max;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.6;
      p.vy *= 0.6;
    }
  }
  return { W, H, k, pos, edges };
}

export function renderGraph(g: Graph, focus: string | undefined, navigate: (path: string) => void): HTMLElement {
  const { W, H, pos, edges } = layout(g, focus);

  // Label priority: the focus article first, then the most connected ones.
  const degree = new Map<string, number>();
  const neighbours = new Map<string, Set<string>>();
  for (const node of g.nodes) neighbours.set(node.id, new Set());
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    neighbours.get(e.from)!.add(e.to);
    neighbours.get(e.to)!.add(e.from);
  }
  // Size = number of links to and from the article within this graph (shared-tag edges don't count, unless
  // the graph has nothing else). sqrt keeps a few hubs from shrinking everything else to the minimum.
  const linkEdges = edges.some((e) => e.kind === 'link') ? edges.filter((e) => e.kind === 'link') : edges;
  const links = new Map<string, number>();
  for (const e of linkEdges) {
    links.set(e.from, (links.get(e.from) ?? 0) + 1);
    links.set(e.to, (links.get(e.to) ?? 0) + 1);
  }
  const maxLinks = Math.max(1, ...links.values());
  const radius = (id: string) => R_MIN + (R_MAX - R_MIN) * Math.sqrt((links.get(id) ?? 0) / maxLinks);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'graph', role: 'img', 'aria-label': 'Article graph', tabindex: '0', preserveAspectRatio: 'xMidYMid meet' });
  root.appendChild(
    svg('defs', {}, svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' }, svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrow' }))),
  );
  const scene = svg('g', {});
  root.appendChild(scene);

  const lines: { el: SVGElement; tag: boolean; from: string; to: string }[] = [];
  for (const e of edges) {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const el = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: e.kind === 'tag' ? 'edge tag' : 'edge', ...(e.kind === 'link' ? { 'marker-end': 'url(#arrow)' } : {}) });
    if (e.tags) el.appendChild(svg('title', {}, e.tags.join(', ')));
    scene.appendChild(el);
    lines.push({ el, tag: e.kind === 'tag', from: e.from, to: e.to });
  }

  let moved = false; // a drag that ended on a node must not navigate
  const nodes: { id: string; grp: SVGElement; circle: SVGElement; text: SVGElement; p: P; r: number; w: number }[] = [];
  for (const node of g.nodes) {
    const p = pos.get(node.id)!;
    const isFocus = node.id === focus;
    const grp = svg('g', { class: `node${isFocus ? ' focus' : ''}`, tabindex: '0', role: 'link', 'data-id': node.id });
    const r = radius(node.id);
    const circle = svg('circle', { cx: p.x, cy: p.y, r });
    const label = node.title.length > 24 ? node.title.slice(0, 23) + '…' : node.title;
    const text = svg('text', { x: p.x + 11, y: p.y + 4 }, label);
    grp.append(circle, text, svg('title', {}, `${node.title} (${node.id}) · リンク ${links.get(node.id) ?? 0}`));
    const go = () => navigate(`/wiki/${node.id}`);
    grp.addEventListener('click', () => {
      if (!moved) go();
    });
    grp.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') go();
    });
    grp.addEventListener('pointerenter', () => highlight(node.id));
    grp.addEventListener('pointerleave', () => highlight(undefined));
    grp.addEventListener('focus', () => highlight(node.id));
    grp.addEventListener('blur', () => highlight(undefined));
    scene.appendChild(grp);
    nodes.push({ id: node.id, grp, circle, text, p, r, w: labelWidthPx(label) });
  }
  const byPriority = [...nodes].sort((a, b) => (b.id === focus ? 1 : 0) - (a.id === focus ? 1 : 0) || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));

  // Hovering a node shows its label and dims everything that is not connected to it.
  function highlight(id: string | undefined) {
    root.classList.toggle('hl', !!id);
    const near = id ? new Set([id, ...neighbours.get(id)!]) : new Set<string>();
    for (const n of nodes) n.grp.classList.toggle('on', near.has(n.id));
    for (const l of lines) l.el.classList.toggle('on', !!id && (l.from === id || l.to === id));
  }

  // ---- view box
  const vb = { x: 0, y: 0, w: W, h: H };
  let frame = 0;
  /** Screen pixels per SVG unit (the viewBox is letterboxed with "meet"). */
  const pxPerUnit = () => {
    const r = root.getBoundingClientRect();
    return r.width && r.height ? Math.min(r.width / vb.w, r.height / vb.h) : 900 / vb.w;
  };
  function apply() {
    frame = 0;
    root.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const s = 1 / pxPerUnit(); // SVG units per screen pixel
    for (const n of nodes) {
      n.circle.setAttribute('r', String(n.r * s));
      n.text.setAttribute('x', String(n.p.x + (n.r + 4) * s));
      n.text.setAttribute('y', String(n.p.y + 4 * s));
    }
    for (const l of lines) {
      // Lines stop at the circles' edges, so arrowheads touch the target whatever its size.
      const a = pos.get(l.from)!;
      const b = pos.get(l.to)!;
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / d;
      const uy = (b.y - a.y) / d;
      const ra = Math.min(radius(l.from) * s, d / 3);
      const rb = Math.min(radius(l.to) * s, d / 3);
      l.el.setAttribute('x1', String(a.x + ux * ra));
      l.el.setAttribute('y1', String(a.y + uy * ra));
      l.el.setAttribute('x2', String(b.x - ux * rb));
      l.el.setAttribute('y2', String(b.y - uy * rb));
      l.el.setAttribute('stroke-width', String(1.2 * s));
      if (l.tag) l.el.setAttribute('stroke-dasharray', `${4 * s} ${3 * s}`);
    }
    root.style.setProperty('--s', String(s));
    placeLabels(s);
  }
  /**
   * Greedy label placement in screen space: in priority order, a label is shown only if its box does not
   * overlap one already shown, so a crowded view shows the most connected articles and zooming in reveals
   * the rest. Hovered nodes (and their neighbours) always show their labels (CSS).
   */
  function placeLabels(s: number) {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const pad = 2 * s;
    for (const n of byPriority) {
      const x0 = n.p.x - (n.r + 2) * s;
      const x1 = n.p.x + (n.r + 4) * s + n.w * s;
      const y0 = n.p.y - 9 * s;
      const y1 = n.p.y + 6 * s;
      const offscreen = x1 < vb.x || x0 > vb.x + vb.w || y1 < vb.y || y0 > vb.y + vb.h;
      const clash = !offscreen && placed.some((b) => x0 < b.x1 + pad && x1 + pad > b.x0 && y0 < b.y1 + pad && y1 + pad > b.y0);
      n.grp.classList.toggle('nolabel', offscreen || clash);
      if (!offscreen && !clash) placed.push({ x0, y0, x1, y1 });
    }
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  function zoomAt(factor: number, cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2) {
    const w = Math.min(W * 2, Math.max(W / MAX_ZOOM, vb.w / factor));
    const f = w / vb.w;
    vb.x = cx - (cx - vb.x) * f;
    vb.y = cy - (cy - vb.y) * f;
    vb.w = w;
    vb.h = vb.h * f;
    schedule();
  }
  function fit() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.p.x);
      y0 = Math.min(y0, n.p.y);
      x1 = Math.max(x1, n.p.x + 160); // room for the label
      y1 = Math.max(y1, n.p.y);
    }
    const pad = 30;
    let w = x1 - x0 + pad * 2;
    let hh = y1 - y0 + pad * 2;
    // Keep the canvas aspect ratio so "meet" does not add uneven margins.
    if (w / hh > W / H) hh = (w * H) / W;
    else w = (hh * W) / H;
    Object.assign(vb, { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - hh / 2, w, h: hh });
    schedule();
  }
  const toSvg = (clientX: number, clientY: number) => {
    const r = root.getBoundingClientRect();
    const ppu = pxPerUnit();
    // Centre of the letterboxed viewBox is the centre of the element.
    return { x: vb.x + vb.w / 2 + (clientX - (r.left + r.width / 2)) / ppu, y: vb.y + vb.h / 2 + (clientY - (r.top + r.height / 2)) / ppu };
  };

  // ---- input: wheel zoom, drag to pan, pinch zoom, keyboard
  // Touch / gesture handling lives on an HTML wrapper: WebKit ignores touch-action on SVG elements, so on iOS a
  // pinch over the <svg> zoomed the whole page.
  const canvas = h('div', { class: 'graph-canvas' }, root);
  // Safari (iOS, and macOS trackpads) reports pinches as non-standard gesture* events and zooms the whole
  // page unless they are cancelled. While a gesture is active it is the only zoom source, so a pointer pinch
  // or ctrl+wheel from the same gesture is not applied twice.
  let gesture: { scale: number } | undefined;
  type GestureLike = Event & { scale: number; clientX: number; clientY: number };
  canvas.addEventListener('gesturestart', (ev) => {
    ev.preventDefault();
    gesture = { scale: (ev as GestureLike).scale || 1 };
  });
  canvas.addEventListener('gesturechange', (ev) => {
    ev.preventDefault();
    const g = ev as GestureLike;
    if (!gesture || !g.scale) return;
    const p = toSvg(g.clientX, g.clientY);
    zoomAt(g.scale / gesture.scale, p.x, p.y);
    gesture.scale = g.scale;
    moved = true;
  });
  canvas.addEventListener('gestureend', (ev) => {
    ev.preventDefault();
    gesture = undefined;
  });
  // Belt and braces for browsers that start a page zoom from a two-finger touch on the graph.
  for (const type of ['touchstart', 'touchmove'] as const) {
    canvas.addEventListener(
      type,
      (ev) => {
        if (ev.touches.length > 1) ev.preventDefault();
      },
      { passive: false },
    );
  }
  root.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      if (gesture) return;
      const p = toSvg(ev.clientX, ev.clientY);
      zoomAt(Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015)), p.x, p.y);
    },
    { passive: false },
  );
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number } | undefined;
  root.addEventListener('pointerdown', (ev) => {
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
    }
  });
  root.addEventListener('pointermove', (ev) => {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    const cur = { x: ev.clientX, y: ev.clientY };
    if (pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (!moved && Math.hypot(dx, dy) < 3) return; // keep clicks on nodes working
      if (!moved) {
        moved = true;
        root.setPointerCapture(ev.pointerId);
        root.classList.add('dragging');
      }
      const ppu = pxPerUnit();
      vb.x -= dx / ppu;
      vb.y -= dy / ppu;
      schedule();
    } else if (pointers.size === 2 && pinch) {
      pointers.set(ev.pointerId, cur);
      if (gesture) return; // Safari: the gesture* handler zooms
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const mid = toSvg((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      if (pinch.d > 0) zoomAt(d / pinch.d, mid.x, mid.y);
      pinch.d = d;
      moved = true;
      return;
    }
    pointers.set(ev.pointerId, cur);
  });
  const release = (ev: PointerEvent) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = undefined;
    if (!pointers.size) root.classList.remove('dragging');
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('keydown', (ev) => {
    const step = vb.w * 0.1;
    const keys: Record<string, () => void> = {
      '+': () => zoomAt(1.25),
      '=': () => zoomAt(1.25),
      '-': () => zoomAt(0.8),
      '0': fit,
      ArrowLeft: () => ((vb.x -= step), schedule()),
      ArrowRight: () => ((vb.x += step), schedule()),
      ArrowUp: () => ((vb.y -= step), schedule()),
      ArrowDown: () => ((vb.y += step), schedule()),
    };
    const fn = keys[ev.key];
    if (fn && ev.target === root) {
      ev.preventDefault();
      fn();
    }
  });
  new ResizeObserver(schedule).observe(root);
  requestAnimationFrame(fit);

  const button = (label: string, title: string, fn: () => void) => h('button', { type: 'button', class: 'secondary', title, 'aria-label': title, onclick: fn }, label);
  const toolbar = h(
    'div',
    { class: 'graph-toolbar' },
    button('＋', '拡大', () => zoomAt(1.4)),
    button('−', '縮小', () => zoomAt(1 / 1.4)),
    button('全体表示', '全体を表示', fit),
    h('span', { class: 'muted' }, 'ホイール・ピンチで拡大縮小、ドラッグで移動。キーボード: + − 0 と矢印キー'),
  );
  return h('div', { class: 'graph-wrap' }, toolbar, canvas);
}
