import { isLocalHost, localBackend, githubBackend, savedAuth, saveAuth, clearAuth } from "./backend.js";

(() => {
const TYPES = {
  core:   { label:"Profile", color:"#00e5ff" },
  area:   { label:"Area",    color:"#ffb547" },
  person: { label:"Person",  color:"#ff5d8f" },
  topic:  { label:"Topic",   color:"#4d9bff" }
};
// One page per memory folder, in nav order.
const CATS = [
  { folder:"areas",  type:"area",   title:"Areas",  sub:"Projects, plans and goals you're working toward." },
  { folder:"people", type:"person", title:"People", sub:"The people in your life." },
  { folder:"topics", type:"topic",  title:"Topics", sub:"Interests, routines and things you know." }
];
// Map circles by life area, from groups.json. Memories not listed there go to the "other" group.
let GROUPS = [], OTHER = { name:"Other", color:"#a9bccd" };
const groupOf = n =>
  GROUPS.find(g => (g.members || []).includes(n.name) || (g.types || []).includes(n.type)) || OTHER;

const typeOf = t => TYPES[t] || TYPES.topic;
const catOf = t => CATS.find(c => c.type === t);
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const memHref = n => `#/m/${encodeURIComponent(n.id)}`;

// ---------- state ----------
let B = { owner:{}, nodes:[], links:[], git:{} };
let nodes = [], links = [], byId = new Map(), byName = new Map(), nbrs = new Map(), core = null;
let hovered = null, hoveredGroup = null, openGroup = null, query = "";
let groups = [];  // life-area bubbles with layout state
const matches = n => {
  if (!query) return false;
  const hay = [n.label, n.summary, ...n.aliases, ...n.facts.map(f => f.text)].join(" ").toLowerCase();
  return hay.includes(query);
};

// Rebuild the graph from brain data, keeping positions of nodes that already exist.
function build(data) {
  const prev = byId, first = prev.size === 0;
  B = data;
  nodes = data.nodes.map(n => {
    const o = prev.get(n.id);
    return { ...n, x:o ? o.x : 0, y:o ? o.y : 0, vx:0, vy:0, deg:0, vis:o ? o.vis : 0, seed:o ? o.seed : Math.random() * 10, fresh:!o };
  });
  byId = new Map(nodes.map(n => [n.id, n]));
  byName = new Map(nodes.map(n => [n.name, n]));
  links = (data.links || [])
    .map(l => ({ ...l, s:byId.get(l.source), t:byId.get(l.target), phase:Math.random() }))
    .filter(l => l.s && l.t);
  nbrs = new Map(nodes.map(n => [n.id, []]));
  links.forEach(l => {
    l.s.deg++; l.t.deg++;
    nbrs.get(l.s.id).push({ node:l.t, label:l.label, kind:l.kind });
    nbrs.get(l.t.id).push({ node:l.s, label:l.label, kind:l.kind });
  });
  core = nodes.find(n => n.type === "core") || nodes[0] || null;
  nodes.forEach(n => {
    n.r = n === core ? 15 : 5 + Math.min(Math.sqrt(n.facts.length) * 1.8, 9);
    n.color = n === core ? TYPES.core.color : groupOf(n).color;
  });
  buildGroups();
  nodes.forEach(n => {
    // New memories start at the center of their bubble.
    if (!n.fresh || !n.g) return;
    n.x = n.g.x + (Math.random() - .5) * 20;
    n.y = n.g.y + (Math.random() - .5) * 20;
  });
  if (hovered) hovered = byId.get(hovered.id) || null;
  if (first) for (let i = 0; i < 300; i++) tick();
}

// Life areas that have memories sit evenly around the core, the first one at the top.
// Each is a small bubble until opened; positions and the open one survive data refreshes.
function buildGroups() {
  const prev = new Map(groups.map(g => [g.name, g]));
  const defs = [...GROUPS, OTHER].filter(d => nodes.some(n => n !== core && groupOf(n) === d));
  const dist = 120 + defs.length * 14;
  groups = defs.map((d, i) => {
    const a = i / defs.length * Math.PI * 2 - Math.PI / 2, o = prev.get(d.name);
    const members = nodes.filter(n => n !== core && groupOf(n) === d);
    const g = {
      name:d.name, color:d.color, members,
      ax:Math.cos(a) * dist, ay:Math.sin(a) * dist,
      x:o ? o.x : Math.cos(a) * dist, y:o ? o.y : Math.sin(a) * dist, vx:0, vy:0,
      small:16 + Math.sqrt(members.length) * 7,
      r:o ? o.r : 0
    };
    members.forEach(n => { n.g = g; });
    return g;
  });
  if (core) core.g = null;
  openGroup = (openGroup && groups.find(g => g.name === openGroup.name)) || null;
  hoveredGroup = null;
}

// ---------- physics ----------
let drag = null;
function tick() {
  // Bubbles grow or shrink toward their size, spring to their slot, and push each other (and the core) apart.
  groups.forEach(g => {
    const target = g === openGroup ? spread(g) : g.small;
    g.r += (target - g.r) * 0.14;
  });
  for (let i = 0; i < groups.length; i++) {
    const a = groups[i];
    for (let j = i + 1; j < groups.length; j++) {
      const b = groups[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, min = a.r + b.r + 34;
      if (d < min) {
        const f = (min - d) * 0.08;
        a.vx -= dx/d*f; a.vy -= dy/d*f; b.vx += dx/d*f; b.vy += dy/d*f;
      }
    }
  }
  groups.forEach(g => {
    const d = Math.hypot(g.x, g.y) || 1, min = g.r + 60;
    if (d < min) { g.vx += g.x/d * (min - d) * .1; g.vy += g.y/d * (min - d) * .1; }
    g.vx += (g.ax - g.x) * 0.012; g.vy += (g.ay - g.y) * 0.012;
    g.vx *= 0.8; g.vy *= 0.8;
    g.x += g.vx; g.y += g.vy;
  });

  // Memories spread out inside the open bubble and gather at the center of closed ones.
  const live = openGroup ? openGroup.members : [];
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      if (dx*dx + dy*dy < 1) { dx = Math.random() - .5; dy = Math.random() - .5; }
      // Floor the distance so members starting on top of each other ease apart instead of exploding.
      const d = Math.max(Math.hypot(dx, dy), 1e-3), f = 3200 / Math.max(d * d, 400);
      a.vx -= dx/d*f; a.vy -= dy/d*f; b.vx += dx/d*f; b.vy += dy/d*f;
    }
  }
  nodes.forEach(n => {
    if (n === core) { n.x = n.y = 0; n.vis = 1; return; }
    const g = n.g, open = g === openGroup;
    n.vis += ((open ? 1 : 0) - n.vis) * 0.12;
    if (!open) { n.x += (g.x - n.x) * .3; n.y += (g.y - n.y) * .3; n.vx = n.vy = 0; return; }
    if (drag && drag.node === n) { n.vx = n.vy = 0; return; }
    n.vx += (g.x - n.x) * 0.02; n.vy += (g.y - n.y) * 0.02;
    n.vx *= 0.8; n.vy *= 0.8;
    n.x += n.vx; n.y += n.vy;
  });
}

// Radius an open bubble needs to hold its members, with room for their labels.
function spread(g) {
  return Math.max(70, ...g.members.map(n => Math.hypot(n.x - g.x, n.y - g.y) + n.r + 30));
}

// ---------- rendering ----------
const cv = $("#graph"), ctx = cv.getContext("2d");
let W = 0, H = 0, dpr = 1;
const view = { x:0, y:0, k:1 };
function resize() {
  const r = cv.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
}
const toWorld = (px, py) => ({ x:(px - W/2 - view.x) / view.k, y:(py - H/2 - view.y) / view.k });
const pos = (n, t) => n === core ? { x:0, y:0 } :
  { x:n.x + Math.sin(t*.7 + n.seed) * 1.8, y:n.y + Math.cos(t*.6 + n.seed) * 1.8 };

// Point on a bubble's rim facing (x, y), so lines stop at the circle.
function rim(g, x, y) {
  const dx = x - g.x, dy = y - g.y, d = Math.hypot(dx, dy) || 1;
  return { x:g.x + dx/d*g.r, y:g.y + dy/d*g.r };
}
const groupHits = g => (query ? g.members.filter(matches).length : 0);

function draw(now) {
  const t = now / 1000, k = view.k;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W/2 + view.x, H/2 + view.y);
  ctx.scale(k, k);

  const focus = hovered;
  const near = new Set(focus ? nbrs.get(focus.id).map(x => x.node.id) : []);
  const pulse = (a, b, p, on, alpha) => {
    ctx.fillStyle = on ? "#ffffff" : `rgba(0,229,255,${alpha})`;
    ctx.beginPath(); ctx.arc(a.x + (b.x-a.x)*p, a.y + (b.y-a.y)*p, (on ? 2.2 : 1.4) / k, 0, Math.PI*2); ctx.fill();
  };

  // core → each bubble
  groups.forEach((g, i) => {
    const b = rim(g, 0, 0), on = g === hoveredGroup || g === openGroup;
    ctx.strokeStyle = `rgba(0,229,255,${on ? .45 : .16})`; ctx.lineWidth = 1 / k;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(b.x, b.y); ctx.stroke();
    pulse({ x:0, y:0 }, b, (t * .25 + i / groups.length) % 1, false, on ? .8 : .35);
  });

  // Links between memories: node to node inside the open bubble, otherwise bubble to bubble (once per pair).
  const seen = new Set();
  links.forEach(l => {
    if (l.kind === "core") return;
    const gs = l.s.g, gt = l.t.g, sOpen = gs === openGroup, tOpen = gt === openGroup;
    if (gs === gt && !sOpen) return;
    if (!sOpen && !tOpen) {
      const key = [gs.name, gt.name].sort().join("|");
      if (seen.has(key)) return;
      seen.add(key);
    }
    let a = sOpen ? pos(l.s, t) : null, b = tOpen ? pos(l.t, t) : null;
    a = a || rim(gs, b ? b.x : gt.x, b ? b.y : gt.y);
    b = b || rim(gt, a.x, a.y);
    const on = focus && (l.s === focus || l.t === focus);
    const base = l.kind === "mention" ? .28 : .5;
    ctx.strokeStyle = on ? "rgba(0,229,255,.9)" : `rgba(0,229,255,${focus ? .06 : base})`;
    ctx.lineWidth = (on ? 1.6 : l.kind === "link" ? 1.4 : 1) / k;
    if (l.kind === "mention") ctx.setLineDash([4/k, 4/k]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    pulse(a, b, (t * .22 + l.phase) % 1, on, base + .2);
    if (on && l.label) {
      ctx.font = `${9.5/k}px JetBrains Mono, monospace`;
      ctx.fillStyle = "rgba(160,230,245,.75)"; ctx.textAlign = "center";
      ctx.fillText(l.label, (a.x+b.x)/2, (a.y+b.y)/2 - 4/k);
    }
  });

  // life-area bubbles: small and solid when closed, a large dashed circle when open
  groups.forEach(g => {
    const open = g === openGroup, hov = g === hoveredGroup, hits = groupHits(g);
    ctx.globalAlpha = query && !hits ? .35 : 1;
    const fill = ctx.createRadialGradient(g.x, g.y, g.r * .1, g.x, g.y, Math.max(g.r, 1));
    fill.addColorStop(0, g.color + (open ? "18" : hov ? "5c" : "3a"));
    fill.addColorStop(1, g.color + (open ? "06" : hov ? "24" : "12"));
    ctx.fillStyle = fill;
    ctx.shadowColor = g.color; ctx.shadowBlur = open ? 0 : hov || hits ? 30 : 14;
    ctx.beginPath(); ctx.arc(g.x, g.y, Math.max(g.r, 0), 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = g.color + (open ? "66" : hov ? "ff" : "aa");
    ctx.lineWidth = (open ? 1.2 : 1.6) / k;
    if (open) { ctx.setLineDash([6/k, 6/k]); ctx.lineDashOffset = t * 6 / k; }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.textAlign = "center";
    if (open) {
      ctx.font = `700 ${11/k}px Orbitron, sans-serif`; ctx.fillStyle = g.color;
      ctx.fillText(`${g.name.toUpperCase()} · ${g.members.length}  ×`, g.x, g.y - g.r - 10/k);
    } else {
      ctx.font = `900 ${Math.max(10, g.r * .6)}px Orbitron, sans-serif`;
      ctx.fillStyle = "#e9fbff"; ctx.textBaseline = "middle";
      ctx.fillText(String(g.members.length), g.x, g.y + 1);
      ctx.textBaseline = "alphabetic";
      ctx.font = `700 ${10.5/k}px Orbitron, sans-serif`; ctx.fillStyle = g.color;
      ctx.fillText(g.name.toUpperCase(), g.x, g.y + g.r + 16/k);
      if (hits) {
        ctx.font = `${9.5/k}px JetBrains Mono, monospace`; ctx.fillStyle = "#e9fbff";
        ctx.fillText(`${hits} match${hits === 1 ? "" : "es"}`, g.x, g.y + g.r + 29/k);
      }
    }
    ctx.globalAlpha = 1;
  });

  // memories: only the core and the open bubble's members
  nodes.forEach(n => {
    if (n !== core && n.vis < .02) return;
    const p = pos(n, t), c = n.color;
    const hit = matches(n);
    const dim = (focus && n !== focus && !near.has(n.id) && n !== core) || (query && !hit && n !== core);
    ctx.globalAlpha = (dim ? .2 : 1) * n.vis;
    ctx.shadowColor = c; ctx.shadowBlur = (n === focus || hit) ? 26 : 12;
    if (n === core) {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, n.r * 1.6);
      g.addColorStop(0, "#ffffff"); g.addColorStop(.35, c); g.addColorStop(1, "rgba(0,229,255,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, n.r * 1.6, 0, Math.PI*2); ctx.fill();
    } else {
      ctx.fillStyle = "rgba(2,12,20,.95)";
      ctx.beginPath(); ctx.arc(p.x, p.y, n.r, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = c; ctx.lineWidth = 1.8 / k; ctx.stroke();
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p.x, p.y, n.r * .42, 0, Math.PI*2); ctx.fill();
    }
    ctx.shadowBlur = 0;
    if (n === focus) {
      ctx.strokeStyle = c; ctx.lineWidth = 1.2 / k;
      ctx.setLineDash([4/k, 4/k]); ctx.lineDashOffset = -t * 12 / k;
      ctx.beginPath(); ctx.arc(p.x, p.y, n.r + 7, 0, Math.PI*2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (n === core || n.vis > .5) {
      ctx.font = `${(n === core ? 12 : 10.5) / k}px JetBrains Mono, monospace`;
      ctx.textAlign = "center";
      ctx.fillStyle = n === focus || n === core ? "#e9fbff" : "rgba(200,238,248,.82)";
      ctx.fillText(n === core ? (B.owner?.name || n.label) : n.label, p.x, p.y + n.r + 15 / k);
    }
    ctx.globalAlpha = 1;
  });
  ctx.restore();
}

let mapVisible = true;
function loop(now) {
  if (mapVisible) { tick(); camera(); draw(now); }
  requestAnimationFrame(loop);
}

// ---------- camera ----------
// Frames all bubbles, or the core plus the open bubble. A manual pan or zoom stops it until the next open/close or ⤢.
const cam = { auto:true, snap:true };
function camera() {
  if (!cam.auto || !W || !groups.length) return;
  let x0 = -40, y0 = -40, x1 = 40, y1 = 40;
  (openGroup ? [openGroup] : groups).forEach(g => {
    x0 = Math.min(x0, g.x - g.r - 20); x1 = Math.max(x1, g.x + g.r + 20);
    y0 = Math.min(y0, g.y - g.r - 30); y1 = Math.max(y1, g.y + g.r + 40);
  });
  const k = Math.min(1.6, (W - 60) / (x1 - x0), (H - 60) / (y1 - y0));
  const s = cam.snap ? 1 : .08;
  view.k += (k - view.k) * s;
  view.x += (-(x0 + x1) / 2 * k - view.x) * s;
  view.y += (-(y0 + y1) / 2 * k - view.y) * s;
  cam.snap = false;
}

// ---------- map interaction ----------
// What's under the pointer: a memory (core or inside the open bubble), else a bubble or its label.
function hitAt(w) {
  let node = null, bd = Infinity;
  nodes.forEach(n => {
    if (n !== core && n.g !== openGroup) return;
    const d = Math.hypot(n.x - w.x, n.y - w.y);
    if (d < n.r + 8 / view.k && d < bd) { node = n; bd = d; }
  });
  if (node) return { node };
  const k = view.k;
  const group = groups.find(g =>
    Math.hypot(w.x - g.x, w.y - g.y) < g.r ||
    (g !== openGroup && Math.abs(w.x - g.x) < 50 / k && w.y > g.y + g.r && w.y < g.y + g.r + 22 / k) ||
    (g === openGroup && Math.abs(w.x - g.x) < 80 / k && Math.abs(w.y - (g.y - g.r - 14 / k)) < 12 / k));
  return { group:group || null };
}
// Open a bubble (closing any other), or close it if it's already open.
function toggle(g) {
  openGroup = g && g !== openGroup ? g : null;
  hovered = null;
  cam.auto = true;
}
const local = e => { const r = cv.getBoundingClientRect(); return { x:e.clientX - r.left, y:e.clientY - r.top }; };

cv.addEventListener("pointerdown", e => {
  const p = local(e), h = hitAt(toWorld(p.x, p.y));
  cv.setPointerCapture(e.pointerId);
  drag = { node:h.node && h.node !== core ? h.node : null, sx:p.x, sy:p.y, vx:view.x, vy:view.y, moved:false };
  cv.classList.add("dragging");
});
cv.addEventListener("pointermove", e => {
  const p = local(e);
  if (drag) {
    if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.node) {
      const w = toWorld(p.x, p.y); drag.node.x = w.x; drag.node.y = w.y;
    } else {
      cam.auto = false;
      view.x = drag.vx + p.x - drag.sx; view.y = drag.vy + p.y - drag.sy;
    }
    return;
  }
  const h = hitAt(toWorld(p.x, p.y));
  hovered = h.node || null;
  hoveredGroup = h.group;
  cv.style.cursor = hovered || hoveredGroup ? "pointer" : "grab";
});
cv.addEventListener("pointerup", e => {
  if (drag && !drag.moved) {
    const p = local(e), h = hitAt(toWorld(p.x, p.y));
    if (h.node) location.hash = memHref(h.node);
    else toggle(h.group);
  }
  drag = null; cv.classList.remove("dragging");
});
cv.addEventListener("pointerleave", () => { hovered = hoveredGroup = null; });
cv.addEventListener("wheel", e => {
  e.preventDefault();
  cam.auto = false;
  zoomAt(local(e), Math.exp(-e.deltaY * .0015));
}, { passive:false });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && mapVisible && openGroup && !$("#editor").open) toggle(null);
});

function zoomAt(p, factor) {
  const w = toWorld(p.x, p.y);
  view.k = Math.min(3, Math.max(.25, view.k * factor));
  view.x = p.x - W/2 - w.x * view.k;
  view.y = p.y - H/2 - w.y * view.k;
}
$("#zIn").onclick = () => { cam.auto = false; zoomAt({ x:W/2, y:H/2 }, 1.25); };
$("#zOut").onclick = () => { cam.auto = false; zoomAt({ x:W/2, y:H/2 }, .8); };
$("#zFit").onclick = () => { cam.auto = true; };

// ---------- routing ----------
function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "m" && parts[1]) return { view:"memory", id:parts[1] };
  const cat = CATS.find(c => c.folder === parts[0]);
  if (cat) return { view:"list", cat };
  return { view:"map" };
}

let fitted = false;
function render() {
  const r = route();
  renderTabs(r);
  mapVisible = r.view === "map";
  document.body.classList.toggle("map-mode", mapVisible);
  $("#mapView").hidden = !mapVisible;
  $("#pageView").hidden = mapVisible;
  hovered = null;
  if (mapVisible) {
    resize();
    if (!fitted && W) { cam.auto = cam.snap = true; fitted = true; }
    document.title = `${firstName()} · Second Brain`;
    return;
  }
  if (r.view === "list") renderList(r.cat);
  else renderMemory(byId.get(r.id));
}

function firstName() { return (B.owner?.name || "").split(" ")[0] || "My"; }

function renderTabs(r) {
  const tabs = $("#tabs");
  tabs.replaceChildren();
  const add = (href, label, color, count, on) => {
    const a = el("a", "tab" + (on ? " on" : ""));
    a.href = href;
    if (color) a.style.setProperty("--c", color);
    a.append(el("i"), el("span", null, label));
    if (count != null) a.append(el("em", null, count));
    if (on) a.setAttribute("aria-current", "page");
    tabs.append(a);
  };
  add("#/", "Map", null, null, r.view === "map");
  if (core) add(memHref(core), "Profile", TYPES.core.color, null, r.view === "memory" && r.id === core.id);
  const active = r.view === "list" ? r.cat.type : r.view === "memory" ? byId.get(r.id)?.type : null;
  CATS.forEach(c => add(`#/${c.folder}`, c.title, typeOf(c.type).color, nodes.filter(n => n.type === c.type).length, active === c.type));
}

// Text with search hits marked and [[name]] turned into links to that memory.
function richText(text) {
  const frag = document.createDocumentFragment();
  const plain = s => {
    if (!query || !s) return frag.append(s);
    const lower = s.toLowerCase();
    let i = 0, j;
    while ((j = lower.indexOf(query, i)) !== -1) {
      frag.append(s.slice(i, j), el("mark", null, s.slice(j, j + query.length)));
      i = j + query.length;
    }
    frag.append(s.slice(i));
  };
  let last = 0;
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    plain(text.slice(last, m.index));
    const target = byName.get(m[1].trim());
    if (target) {
      const a = el("a", "wl", target.label);
      a.href = memHref(target);
      frag.append(a);
    } else frag.append(m[1]);
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return frag;
}

function renderList(cat) {
  const page = $("#pageView");
  page.replaceChildren();
  const color = typeOf(cat.type).color;
  page.style.setProperty("--c", color);
  document.title = `${cat.title} · ${firstName()} · Second Brain`;

  const all = nodes.filter(n => n.type === cat.type);
  const shown = query ? all.filter(matches) : all;
  const head = el("div", "page-head");
  const h = el("div");
  h.append(el("h2", null, cat.title), el("p", null, `${cat.sub} ${all.length} file${all.length === 1 ? "" : "s"} · ${all.reduce((s, n) => s + n.facts.length, 0)} facts in ${cat.folder}/`));
  const add = el("button", "btn", `+ New in ${cat.folder}`);
  add.onclick = () => openEditor(null, cat.folder);
  head.append(h, add);
  page.append(head);

  if (!shown.length) {
    page.append(el("p", "empty", query ? `Nothing in ${cat.title.toLowerCase()} matches “${query}”.` : "No memories here yet."));
    return;
  }
  const grid = el("div", "cards");
  shown
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.facts.length - a.facts.length)
    .forEach(n => {
      const card = el("a", "panel card");
      card.href = memHref(n);
      card.style.setProperty("--c", color);
      const title = el("h3");
      title.append(richText(n.label));
      const desc = el("p");
      desc.append(richText(n.summary || ""));
      const ul = el("ul");
      const preview = query ? n.facts.filter(f => f.text.toLowerCase().includes(query)) : n.facts;
      preview.slice(0, 3).forEach(f => { const li = el("li"); li.append(richText(f.text.replace(/\[\[([^\]|#]+)[^\]]*\]\]/g, "$1"))); ul.append(li); });
      const foot = el("footer");
      foot.append(el("span", null, `${n.facts.length} fact${n.facts.length === 1 ? "" : "s"}`), el("span", null, n.date ? `updated ${n.date}` : n.file));
      card.append(title, desc, ul, foot);
      grid.append(card);
    });
  page.append(grid);
}

function renderMemory(n) {
  const page = $("#pageView");
  page.replaceChildren();
  if (!n) {
    page.append(el("p", "empty", "That memory doesn't exist anymore."));
    return;
  }
  const ty = typeOf(n.type), cat = catOf(n.type);
  page.style.setProperty("--c", ty.color);
  const isCore = n === core;
  document.title = `${isCore ? B.owner?.name : n.label} · Second Brain`;

  const head = el("div", "page-head");
  const h = el("div");
  if (cat) {
    const crumb = el("a", "crumb", `‹ ${cat.title}`);
    crumb.href = `#/${cat.folder}`;
    h.append(crumb, el("br"));
  }
  const badge = el("span", "badge", (isCore ? "PROFILE" : ty.label).toUpperCase());
  badge.style.setProperty("--c", ty.color);
  const title = el("h2", null, isCore ? B.owner?.name || n.label : n.label);
  h.append(badge, title);
  if (n.summary) { const p = el("p"); p.append(richText(n.summary)); h.append(p); }
  const acts = el("div", "acts");
  const edit = el("button", "btn", "Edit");
  edit.onclick = () => openEditor(n);
  acts.append(edit);
  if (!isCore) {
    const del = el("button", "btn danger", "Delete");
    del.onclick = () => remove(n);
    acts.append(del);
  }
  head.append(h, acts);
  page.append(head);

  const grid = el("div", "mem");
  const main = el("section", "panel");
  const mh = el("div", "ph");
  mh.append(el("span", null, "Facts"), el("span", null, String(n.facts.length)));
  main.append(mh);
  const body = el("div", "facts");
  let ul = null, section;
  n.facts.forEach(f => {
    if (!ul || f.section !== section) {
      section = f.section;
      if (section) body.append(el("div", "sec", section));
      ul = el("ul", "fl");
      body.append(ul);
    }
    const li = el("li");
    li.append(richText(f.text));
    if (f.tag && f.tag !== "stated") li.append(el("span", "tag", f.tag));
    ul.append(li);
  });
  if (!n.facts.length) body.append(el("p", "empty", "No facts yet. Use Edit to add some."));
  main.append(body);

  const side = el("aside", "side");
  const info = el("section", "panel");
  const ib = el("div", "pb");
  ib.append(el("div", "lbl", "Record"));
  const meta = el("dl", "meta");
  [["FILE", n.file], ["SOURCES", n.sources.join(", ")], ["UPDATED", n.date], ["FACTS", String(n.facts.length)]]
    .filter(([, v]) => v).forEach(([k, v]) => meta.append(el("dt", null, k), el("dd", null, v)));
  ib.append(meta);
  info.append(ib);
  side.append(info);

  if (n.aliases.length) {
    const box = el("section", "panel");
    const pb = el("div", "pb");
    const a = el("div", "aliases");
    n.aliases.forEach(x => a.append(el("span", null, x)));
    pb.append(el("div", "lbl", "Also called"), a);
    box.append(pb);
    side.append(box);
  }

  const ns = (nbrs.get(n.id) || []).filter(x => isCore || x.node !== core);
  if (ns.length) {
    const box = el("section", "panel");
    const pb = el("div", "pb");
    pb.append(el("div", "lbl", `Connected · ${ns.length}`));
    const list = el("div", "conns");
    ns.sort((a, b) => (a.kind === "link" ? 0 : 1) - (b.kind === "link" ? 0 : 1) || a.node.label.localeCompare(b.node.label))
      .forEach(({ node, label, kind }) => {
        const a = el("a", "conn");
        a.href = memHref(node);
        const dot = el("i"); dot.style.setProperty("--c", typeOf(node.type).color);
        a.append(dot, el("span", null, node === core ? B.owner?.name || node.label : node.label), el("small", null, kind === "core" ? typeOf(node.type).label.toLowerCase() : label || ""));
        list.append(a);
      });
    pb.append(list);
    box.append(pb);
    side.append(box);
  }

  grid.append(main, side);
  page.append(grid);
}

function renderGit() {
  const g = B.git || {}, btn = $("#syncBtn");
  btn.hidden = !g.available;
  if (!g.available) return;
  const parts = [];
  if (g.changed) parts.push(`${g.changed} changed`);
  if (g.ahead) parts.push(`${g.ahead} to push`);
  if (g.behind) parts.push(`${g.behind} to pull`);
  btn.classList.toggle("dirty", parts.length > 0);
  $("#syncLabel").textContent = parts.length ? `Sync · ${parts.join(" · ")}` : "Synced";
  btn.title = parts.length ? "Commit, pull and push to GitHub" : "Up to date with GitHub. Click to check again.";
}

function renderChrome() {
  $("#brandName").textContent = firstName().toUpperCase();
  $("#graphInfo").textContent = `${nodes.length} FILES · ${nodes.reduce((s, n) => s + n.facts.length, 0)} FACTS · ${links.filter(l => l.kind !== "core").length} LINKS`;
  $("#sync").textContent = `${backend.mode === "github" ? "GITHUB" : "LIVE"} · ${(B.git?.branch || "local").toUpperCase()}`;
  $("#signOutBtn").hidden = backend.mode !== "github";
  renderGit();
}

let toastTimer;
function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, 3200);
}

// ---------- data ----------
// The local server when running on this machine; the GitHub API (with the user's token) on GitHub Pages.
let backend = null;
const onGitHub = () => backend.mode === "github";

function apply(data) {
  if (data.groups) {
    GROUPS = data.groups.groups || [];
    if (data.groups.other) OTHER = data.groups.other;
  }
  build(data);
  renderChrome();
  render();
}
const refresh = async () => apply(await backend.load());

function watchChanges() {
  backend.watch(() => {
    // Don't re-render a page under an open editor.
    if ($("#editor").open) return;
    refresh().catch(() => {});
  }, live => {
    $("#liveDot").classList.toggle("off", !live);
    if (live) renderChrome();
    else $("#sync").textContent = "OFFLINE";
  });
}

async function remove(n) {
  const what = onGitHub()
    ? "This commits the deletion to GitHub right away."
    : "The file is removed here. After you sync,";
  const ok = confirm(`Delete ${n.file}?\n\n${what} The weekly memory sync will ask before removing it from Claude's memory.`);
  if (!ok) return;
  try {
    await backend.remove(n);
    location.hash = `#/${catOf(n.type)?.folder || ""}`;
    await refresh();
    toast(onGitHub() ? `Deleted ${n.file} on GitHub.` : `Deleted ${n.file}. Sync to push it.`);
  } catch (e) { toast(e.message, true); }
}

$("#syncBtn").onclick = async () => {
  const btn = $("#syncBtn");
  btn.disabled = true;
  $("#syncLabel").textContent = "Syncing…";
  try {
    const r = await backend.sync();
    await refresh();
    toast(r.steps.length ? `GitHub: ${r.steps.join(", ")}` : "Already up to date with GitHub");
  } catch (e) {
    toast(e.message, true);
    renderGit();
  } finally {
    btn.disabled = false;
  }
};

// Search filters the current page and highlights on the map; Enter opens the first match.
$("#q").addEventListener("input", e => {
  query = e.target.value.trim().toLowerCase();
  if (!mapVisible) render();
});
$("#q").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const r = route();
  const pool = r.view === "list" ? nodes.filter(n => n.type === r.cat.type) : nodes;
  const m = pool.find(n => n !== core && matches(n));
  if (m) location.hash = memHref(m);
});

// ---------- editor ----------
const dlg = $("#editor"), form = $("#edForm");
let editing = null;

function openEditor(n, folder) {
  editing = n || null;
  form.reset();
  $("#edErr").textContent = "";
  $("#edTitle").textContent = n ? `Edit · ${n.file}` : "New memory";
  form.folder.disabled = form.slug.disabled = !!n;
  if (n) {
    form.folder.value = n.file.includes("/") ? n.file.split("/")[0] : "topics";
    form.slug.value = n.name;
    form.description.value = n.summary;
    form.aliases.value = n.aliases.join(", ");
    form.body.value = n.body.replace(/^\n+/, "").replace(/\n+$/, "");
  } else if (folder) {
    form.folder.value = folder;
  }
  dlg.showModal();
  (n ? form.body : form.slug).focus();
}

$("#addBtn").onclick = () => {
  const r = route();
  openEditor(null, r.view === "list" ? r.cat.folder : undefined);
};
$("#edCancel").onclick = () => dlg.close();

form.addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#edErr");
  if (!editing && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(form.slug.value.trim())) {
    err.textContent = "Name must be lowercase words joined by hyphens, e.g. weekend-trips";
    return;
  }
  if (!form.description.value.trim()) { err.textContent = "Add a one-line description"; return; }
  const body = {
    description: form.description.value,
    aliases: form.aliases.value.split(",").map(s => s.trim()).filter(Boolean),
    body: form.body.value
  };
  try {
    const res = editing
      ? await backend.update(editing, body)
      : await backend.create({ ...body, folder:form.folder.value, name:form.slug.value.trim() });
    dlg.close();
    await refresh();
    const target = byId.get(res.id) || byName.get(res.id);
    if (target) location.hash = memHref(target);
    const done = editing ? "Saved" : "Memory added";
    toast(onGitHub() ? `${done} to GitHub.` : `${done}. Sync to push it to GitHub.`);
  } catch (ex) {
    err.textContent = ex.message;
  }
});

// ---------- boot ----------
function clock() {
  $("#clock").textContent = new Date().toLocaleTimeString([], { hour12:false });
}

function bootLines(lines, bad) {
  const pre = $("#bootText");
  pre.replaceChildren();
  lines.forEach((l, i) => {
    const s = el("span", bad && i === lines.length - 1 ? "bad" : null, l + "\n");
    s.style.animationDelay = (i * .2) + "s";
    pre.append(s);
  });
}

// ---------- sign-in (GitHub Pages) ----------
// The repo name is remembered separately so it's prefilled after signing out; the token never is.
const REPO_KEY = "secondbrain.repo";
const lastRepo = () => { try { return localStorage.getItem(REPO_KEY) || ""; } catch { return ""; } };
const keepRepo = r => { try { localStorage.setItem(REPO_KEY, r); } catch { /* ignore */ } };

// Shows the sign-in form until a token loads the repo; resolves with that backend and its data.
function signIn(error) {
  const box = $("#signin"), f = $("#signinForm"), err = $("#siErr");
  $("#boot").classList.add("done");
  box.hidden = false;
  err.textContent = error || "";
  if (!f.repo.value) f.repo.value = lastRepo();
  (f.repo.value ? f.token : f.repo).focus();
  return new Promise(resolve => {
    f.onsubmit = async e => {
      e.preventDefault();
      const repo = f.repo.value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
      const token = f.token.value.trim();
      if (!repo || !token) { err.textContent = "Enter the repository and a token."; return; }
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      err.textContent = "Connecting…";
      try {
        const be = githubBackend({ repo, token });
        const data = await be.load();  // proves the token works before it's stored
        saveAuth({ repo, token }, f.remember.checked);
        keepRepo(repo);
        f.token.value = "";
        box.hidden = true;
        resolve({ be, data });
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        btn.disabled = false;
      }
    };
  });
}

$("#signOutBtn").onclick = () => {
  if (!confirm("Sign out on this device?\n\nYour token is removed from this browser. Your memory on GitHub is not affected.")) return;
  clearAuth();
  location.reload();
};

async function connect() {
  if (isLocalHost) {
    backend = localBackend();
    return backend.load();
  }
  const auth = savedAuth();
  let error;
  if (auth) {
    try {
      backend = githubBackend(auth);
      return await backend.load();
    } catch (e) {
      error = e.message;
      if (e.status === 401 || e.status === 404) clearAuth();
    }
  }
  const { be, data } = await signIn(error);
  backend = be;
  return data;
}

async function start() {
  clock(); setInterval(clock, 1000);
  try {
    apply(await connect());
  } catch {
    bootLines(isLocalHost
      ? ["> core online", "> memory server not reachable", "> run `npm start` in the dashboard folder"]
      : ["> core online", "> couldn't load your memory", "> check your connection and reload"], true);
    return;
  }
  bootLines([
    "> core online",
    `> reading second-brain repo … ${nodes.length} files`,
    `> indexing ${nodes.reduce((s, n) => s + n.facts.length, 0)} facts`,
    `> clustering ${groups.map(g => g.name.toLowerCase()).join(" · ")}`,
    `> welcome back, ${firstName().toUpperCase()}.`
  ]);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(() => $("#boot").classList.add("done"), reduce ? 0 : 1500);
  watchChanges();
  requestAnimationFrame(loop);
}

window.addEventListener("hashchange", render);
window.addEventListener("resize", () => { if (mapVisible) resize(); });
start();
})();
