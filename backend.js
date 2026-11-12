// Two ways to reach the memory, with the same interface:
//   local  — the Node server in this folder (npm start): edits files on disk; Sync commits and pushes.
//   github — the private repo through the GitHub API with the user's own token (GitHub Pages).
//            Every save is a commit. Nothing is stored anywhere except the repo and this browser.
import { buildBrain, memoryFile, newMemory, updatedText, MemoryError, PROFILE, FOLDERS } from "./memory-core.js";

const GROUPS_PATH = "dashboard/public/groups.json";

export const isLocalHost = ["localhost", "127.0.0.1"].includes(globalThis.location?.hostname);

// ---------- local server ----------
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new MemoryError(res.status, json.error || `Request failed (${res.status})`);
  return json;
}

export function localBackend() {
  return {
    mode: "local",
    async load() {
      const [brain, groups] = await Promise.all([
        call("GET", "/api/brain"),
        fetch("groups.json", { cache: "no-store" }).then(r => (r.ok ? r.json() : null)).catch(() => null)
      ]);
      return { ...brain, groups };
    },
    create: input => call("POST", "/api/memories", input),
    update: (node, input) => call("PATCH", `/api/memories/${encodeURIComponent(node.id)}`, input),
    remove: node => call("DELETE", `/api/memories/${encodeURIComponent(node.id)}`),
    sync: () => call("POST", "/api/git/sync"),
    watch(onChange, onStatus) {
      const es = new EventSource("/api/events");
      es.onopen = () => onStatus(true);
      es.addEventListener("change", onChange);
      es.onerror = () => onStatus(false);
    }
  };
}

// ---------- GitHub ----------
const AUTH_KEY = "secondbrain.github";
const stores = () => [globalThis.localStorage, globalThis.sessionStorage].filter(Boolean);

// { repo:"owner/name", token, branch? } from this browser, if the user chose to stay signed in.
export function savedAuth() {
  for (const s of stores()) {
    try {
      const v = JSON.parse(s.getItem(AUTH_KEY) || "null");
      if (v?.repo && v?.token) return v;
    } catch { /* storage blocked or corrupt: treat as signed out */ }
  }
  return null;
}
export function saveAuth(auth, remember) {
  clearAuth();
  try { (remember ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify(auth)); } catch { /* signed in for this page only */ }
}
export function clearAuth() {
  for (const s of stores()) { try { s.removeItem(AUTH_KEY); } catch { /* ignore */ } }
}

// Base64 for UTF-8 text (the files contain ₹ and other non-ASCII characters).
function encode64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const decode64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));

export function githubBackend({ repo, token, branch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new MemoryError(400, "Repository must look like owner/name");
  const base = `https://api.github.com/repos/${repo}`;
  const path = rel => rel.split("/").map(encodeURIComponent).join("/");
  let ref = branch || null, head = null;
  const files = new Map();   // rel → { sha, text } for memory files at `head`
  const dates = new Map();   // blob sha → last commit date of the file holding it

  async function gh(method, url, body) {
    const res = await fetch(url.startsWith("https://") ? url : base + url, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.ok) return res.status === 204 ? null : res.json();
    let msg = "";
    try { msg = (await res.json()).message || ""; } catch { /* no body */ }
    if (res.status === 401) msg = "GitHub didn't accept the token. It may be wrong, expired or revoked.";
    else if (res.status === 404 && !head) msg = `Can't see ${repo}. Check the name, and that the token has access to it.`;
    else if (res.status === 403 && /permission|accessible/i.test(msg)) msg = "The token can read but not write. Give it Contents: Read and write.";
    else if (res.status === 409 || (res.status === 422 && /sha/i.test(msg))) msg = "This memory changed on GitHub since it was loaded. Reload and try again.";
    throw new MemoryError(res.status, msg || `GitHub error ${res.status}`);
  }

  async function blobText(sha) {
    const b = await gh("GET", `/git/blobs/${sha}`);
    return decode64(b.content);
  }

  async function lastChanged(rel, sha) {
    if (dates.has(sha)) return dates.get(sha);
    const c = await gh("GET", `/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(rel)}&per_page=1`).catch(() => []);
    const d = c[0]?.commit?.committer?.date?.slice(0, 10) || null;
    dates.set(sha, d);
    return d;
  }

  async function headCommit() {
    const b = await gh("GET", `/branches/${encodeURIComponent(ref)}`);
    return { sha: b.commit.sha, tree: b.commit.commit.tree.sha };
  }

  return {
    mode: "github",
    repo,
    get branch() { return ref; },

    async load() {
      if (!ref) ref = (await gh("GET", "")).default_branch;
      const h = await headCommit();
      const tree = await gh("GET", `/git/trees/${h.tree}?recursive=1`);
      const entries = tree.tree.filter(e => e.type === "blob" && memoryFile(e.path));
      const groupsEntry = tree.tree.find(e => e.path === GROUPS_PATH);

      // Only fetch files whose content changed since the last load.
      const next = new Map();
      await Promise.all(entries.map(async e => {
        const old = files.get(e.path);
        next.set(e.path, { sha: e.sha, text: old && old.sha === e.sha ? old.text : await blobText(e.sha) });
      }));
      files.clear();
      [...next.keys()].sort((a, b) => (a === PROFILE ? -1 : b === PROFILE ? 1 : a.localeCompare(b)))
        .forEach(k => files.set(k, next.get(k)));
      head = h.sha;

      const [groups, commits] = await Promise.all([
        groupsEntry ? blobText(groupsEntry.sha).then(t => JSON.parse(t)).catch(() => null) : null,
        gh("GET", `/commits?sha=${encodeURIComponent(ref)}&per_page=40`).catch(() => [])
      ]);
      const brain = buildBrain([...files].map(([rel, f]) => ({ rel, text: f.text })));
      await Promise.all(brain.nodes.map(async n => { n.date = await lastChanged(n.file, files.get(n.file).sha); }));
      return {
        ...brain,
        groups,
        log: commits.map(c => ({ date: c.commit.committer.date.slice(0, 10), text: c.commit.message.split("\n")[0] })),
        git: { available: false, branch: ref, repo }
      };
    },

    async create(input) {
      const { name, rel, text } = newMemory(input);
      if (Object.keys(FOLDERS).some(dir => files.has(`${dir}/${name}.md`))) {
        throw new MemoryError(409, `A memory named "${name}" already exists`);
      }
      const r = await gh("PUT", `/contents/${path(rel)}`, {
        message: `Add ${rel} from Second Brain app`, content: encode64(text), branch: ref
      });
      files.set(rel, { sha: r.content.sha, text });
      return { id: name, file: rel };
    },

    async update(node, input) {
      const f = files.get(node.file);
      if (!f) throw new MemoryError(404, "Memory not found. Reload and try again.");
      const text = updatedText(f.text, input);
      if (text === f.text) return { id: node.id };
      const r = await gh("PUT", `/contents/${path(node.file)}`, {
        message: `Update ${node.file} from Second Brain app`, content: encode64(text), sha: f.sha, branch: ref
      });
      files.set(node.file, { sha: r.content.sha, text });
      return { id: node.id };
    },

    async remove(node) {
      if (node.file === PROFILE) throw new MemoryError(400, "The profile can't be deleted");
      const f = files.get(node.file);
      if (!f) throw new MemoryError(404, "Memory not found. Reload and try again.");
      await gh("DELETE", `/contents/${path(node.file)}`, {
        message: `Delete ${node.file} from Second Brain app`, sha: f.sha, branch: ref
      });
      files.delete(node.file);
      return { id: node.id };
    },

    // Picks up commits made elsewhere (the weekly sync, another device) by checking the branch head.
    watch(onChange, onStatus) {
      const check = async () => {
        if (globalThis.document?.hidden || !head) return;
        try {
          const h = await headCommit();
          onStatus(true);
          if (h.sha !== head) onChange();
        } catch { onStatus(false); }
      };
      setInterval(check, 60_000);
      globalThis.document?.addEventListener("visibilitychange", check);
    }
  };
}
