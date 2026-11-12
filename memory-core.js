// Memory file format, shared by the local server (Node) and the GitHub Pages app (browser).
//   profile.md, areas/*.md, people/*.md, topics/*.md
// Each file: frontmatter (name, description, sources, aliases) + "- [stated] fact" lines.
// Writes keep the file's frontmatter order, extra keys, headings and line endings.
// Pure functions only: no file system or network access.

export const FOLDERS = { areas: "area", people: "person", topics: "topic" };
export const PROFILE = "profile.md";
export const MEMORY_PATHS = [PROFILE, ...Object.keys(FOLDERS)];
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STD_KEYS = ["name", "description", "sources", "aliases"];

export class MemoryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Which memory files a repo path is, or null: { rel, type }.
export function memoryFile(rel) {
  if (rel === PROFILE) return { rel, type: "core" };
  const m = rel.match(/^([^/]+)\/[^/]+\.md$/);
  return m && FOLDERS[m[1]] ? { rel, type: FOLDERS[m[1]] } : null;
}

// ---------- parsing ----------
const unquote = s => (/^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s);

function parseValue(v) {
  v = v.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v.slice(1, -1).split(",").map(s => unquote(s.trim())).filter(Boolean);
  }
  return unquote(v);
}

export function parseFile(text) {
  const src = text.replace(/^﻿/, "");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const norm = src.replace(/\r\n/g, "\n");
  const m = norm.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {}, order = [];
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      order.push(kv[1]);
      meta[kv[1]] = parseValue(kv[2]);
    }
  }
  return { meta, order, body: m ? m[2] : norm, eol };
}

export function serialize({ meta, order = [], body, eol = "\n" }) {
  const keys = [...order, ...STD_KEYS.filter(k => !order.includes(k))].filter(k => meta[k] !== undefined);
  const fmt = v => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
  const text = `---\n${keys.map(k => `${k}: ${fmt(meta[k])}`).join("\n")}\n---\n${body.replace(/\n*$/, "\n")}`;
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

export function parseFacts(body) {
  const out = [];
  let section = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { section = h[1]; continue; }
    const f = line.match(/^[-*]\s+(?:\[(\w+)\]\s*)?(.*)$/);
    out.push(f ? { text: f[2], tag: f[1] || null, section } : { text: line, tag: null, section });
  }
  return out;
}

// Plain lines typed in the dashboard become "- [stated] …" facts; headings and list items stay as written.
export function normalizeBody(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(l => {
      const t = l.trim();
      if (!t || t.startsWith("#") || /^[-*]\s/.test(t)) return l.trimEnd();
      return `- [stated] ${t}`;
    })
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
}

const wikiLinks = text => [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(m => m[1].trim());
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const baseName = rel => rel.split("/").pop().replace(/\.md$/, "");

function humanize(name, aliases) {
  const flat = s => s.toLowerCase().replace(/[\s_-]+/g, "");
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const alias = aliases.find(a => flat(a) === flat(name));
  if (alias) return alias === alias.toLowerCase() ? cap(alias) : alias;
  return cap(name.split("-").map(w => (w.length <= 2 ? w.toUpperCase() : w)).join(" "));
}

const asList = v => (Array.isArray(v) ? v : v ? [v] : []);

// ---------- graph ----------
// files: [{ rel, text }] for profile.md and the folder files, sorted by path.
export function buildBrain(files) {
  const nodes = [];
  for (const { rel, text } of files) {
    const f = memoryFile(rel);
    if (!f) continue;
    const { meta, body } = parseFile(text);
    const name = meta.name || baseName(rel);
    const aliases = asList(meta.aliases);
    const facts = parseFacts(body);
    let label = humanize(name, aliases), tagline = "";
    if (f.type === "core") {
      const nameFact = facts.find(x => /^name:/i.test(x.text));
      label = nameFact ? nameFact.text.replace(/^name:\s*/i, "") : "You";
      tagline = facts.find(x => x !== nameFact)?.text || "";
    }
    nodes.push({
      id: f.type === "core" ? "profile" : name,
      file: rel, type: f.type, name, label, tagline,
      summary: meta.description || "",
      aliases, sources: asList(meta.sources),
      facts, body
    });
  }

  // Duplicate names across folders fall back to the path as id.
  const seen = new Map();
  nodes.forEach(n => seen.set(n.id, (seen.get(n.id) || 0) + 1));
  nodes.forEach(n => { if (seen.get(n.id) > 1) n.id = n.file.replace(/\.md$/, ""); });

  const core = nodes.find(n => n.type === "core");
  const byName = new Map(nodes.map(n => [n.name, n]));
  const links = [];
  const has = (a, b) => links.some(l => (l.source === a && l.target === b) || (l.source === b && l.target === a));
  const add = (source, target, label, kind) => { if (source !== target && !has(source, target)) links.push({ source, target, label, kind }); };

  // Explicit [[name]] links first, then mentions of another memory's name or aliases.
  for (const n of nodes) {
    for (const ref of wikiLinks(n.body)) {
      const t = byName.get(ref) || byName.get(baseName(ref));
      if (t) add(n.id, t.id, "links", "link");
    }
  }
  for (const n of nodes) {
    if (n === core) continue;
    const hay = (n.summary + "\n" + n.body.replace(/\[\[[^\]]*\]\]/g, "")).toLowerCase();
    for (const t of nodes) {
      if (t === n || t === core) continue;
      const terms = [t.name.replace(/-/g, " "), ...t.aliases].map(s => s.toLowerCase()).filter(s => s.length >= 4);
      if (terms.some(term => new RegExp(`\\b${escapeRe(term)}\\b`).test(hay))) add(n.id, t.id, "mentions", "mention");
    }
  }
  if (core) {
    const rel = { area: "pursues", person: "knows", topic: "into" };
    for (const n of nodes) if (n !== core) add(core.id, n.id, rel[n.type], "core");
  }

  return {
    owner: { name: core?.label || "You", tagline: core?.tagline || "" },
    nodes,
    links
  };
}

// ---------- writing ----------
const cleanList = v =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map(s => String(s).trim().replace(/[[\],]/g, "").slice(0, 60))
    .filter(Boolean)
    .slice(0, 20);
const cleanLine = (v, max) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

// A new memory file: validates folder and name, returns { name, rel, text }.
export function newMemory({ folder, name, description, aliases, body }) {
  if (!FOLDERS[folder]) throw new MemoryError(400, "Pick areas, people or topics");
  name = String(name ?? "").trim().toLowerCase();
  if (!NAME_RE.test(name) || name.length > 60) {
    throw new MemoryError(400, "Name must be lowercase words joined by hyphens, e.g. weekend-trips");
  }
  const text = serialize({
    meta: { name, description: cleanLine(description, 300), sources: ["dashboard"], aliases: cleanList(aliases) },
    body: normalizeBody(body)
  });
  return { name, rel: `${folder}/${name}.md`, text };
}

// An existing file's text with description, aliases and/or body replaced.
export function updatedText(text, { description, aliases, body }) {
  const parsed = parseFile(text);
  if (description !== undefined) parsed.meta.description = cleanLine(description, 300);
  if (aliases !== undefined) parsed.meta.aliases = cleanList(aliases);
  if (body !== undefined) parsed.body = normalizeBody(body);
  return serialize(parsed);
}
