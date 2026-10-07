// Small force-directed graph renderer (SVG, no dependencies).
import type { Graph } from '../shared/types.js';
import { svg } from './dom.js';

export function renderGraph(g: Graph, focus: string | undefined, navigate: (path: string) => void): SVGElement {
  const W = 900;
  const H = 600;
  const n = g.nodes.length;
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  g.nodes.forEach((node, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, n);
    pos.set(node.id, { x: W / 2 + Math.cos(a) * 200, y: H / 2 + Math.sin(a) * 200, vx: 0, vy: 0 });
  });
  if (focus && pos.has(focus)) Object.assign(pos.get(focus)!, { x: W / 2, y: H / 2 });
  const edges = g.edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.6;
  for (let iter = 0; iter < 300; iter++) {
    const t = 1 - iter / 300;
    const ps = [...pos.values()];
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]!;
        const b = ps[j]!;
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const d2 = dx * dx + dy * dy;
        const f = (k * k) / d2;
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
      p.vx += (W / 2 - p.x) * 0.002;
      p.vy += (H / 2 - p.y) * 0.002;
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const max = 20 * t + 1;
      if (v > max) {
        p.vx = (p.vx / v) * max;
        p.vy = (p.vy / v) * max;
      }
      p.x = Math.min(W - 40, Math.max(40, p.x + p.vx));
      p.y = Math.min(H - 20, Math.max(20, p.y + p.vy));
      p.vx *= 0.6;
      p.vy *= 0.6;
    }
  }
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'graph', role: 'img', 'aria-label': 'Article graph' });
  root.appendChild(
    svg('defs', {}, svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '18', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' }, svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrow' }))),
  );
  for (const e of edges) {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: e.kind === 'tag' ? 'edge tag' : 'edge', ...(e.kind === 'link' ? { 'marker-end': 'url(#arrow)' } : {}) });
    if (e.tags) line.appendChild(svg('title', {}, e.tags.join(', ')));
    root.appendChild(line);
  }
  for (const node of g.nodes) {
    const p = pos.get(node.id)!;
    const grp = svg('g', { class: `node${node.id === focus ? ' focus' : ''}`, tabindex: '0', role: 'link' });
    grp.appendChild(svg('circle', { cx: p.x, cy: p.y, r: node.id === focus ? 10 : 7 }));
    const label = node.title.length > 24 ? node.title.slice(0, 23) + '…' : node.title;
    grp.appendChild(svg('text', { x: p.x + 11, y: p.y + 4 }, label));
    grp.appendChild(svg('title', {}, `${node.title} (${node.id})`));
    const go = () => navigate(`/wiki/${node.id}`);
    grp.addEventListener('click', go);
    grp.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') go();
    });
    root.appendChild(grp);
  }
  return root;
}
