// Small helpers shared by every command.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const VERSION = "0.1.0";
export const UA_SUFFIX = `Remake/${VERSION} (+https://github.com/rubenhassid1/remake)`;

export const say = (msg = "") => process.stdout.write(msg + "\n");
export const ok = (msg) => say(`  ✓ ${msg}`);
export const warn = (msg) => say(`  ! ${msg}`);
export const step = (msg) => say(`\n▸ ${msg}`);

export class RemakeError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function writeFile(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data);
}

export const sha1 = (data) => crypto.createHash("sha1").update(data).digest("hex");

// FNV-1a, 32 bit. The replay runtime in the browser uses the same function, so keys match.
export function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function walk(dir, filter = () => true, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "site";
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// Minimal argv parser: positionals plus --flag, --flag value, --flag=value.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

export function table(rows) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] || 0, String(c).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

export function newestMtime(dir, skip = () => false) {
  let newest = 0;
  for (const f of walk(dir, (f) => !skip(f))) newest = Math.max(newest, fs.statSync(f).mtimeMs);
  return newest;
}

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".pdf": "application/pdf",
};

export const EXT_FOR_TYPE = {
  "text/html": ".html",
  "text/css": ".css",
  "text/javascript": ".js",
  "application/javascript": ".js",
  "application/x-javascript": ".js",
  "application/json": ".json",
  "image/svg+xml": ".svg",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "font/woff": ".woff",
  "font/woff2": ".woff2",
  "font/ttf": ".ttf",
  "font/otf": ".otf",
  "application/font-woff": ".woff",
  "application/font-woff2": ".woff2",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "application/wasm": ".wasm",
  "text/plain": ".txt",
  "application/xml": ".xml",
  "text/xml": ".xml",
};

export const TEXT_EXT = /\.(html?|css|m?js|json|svg|xml|txt|webmanifest)$/i;

// Is this file binary? Servers mislabel files (a 3D model sent as text/html), so look at the bytes:
// known file signatures first, then any NUL byte in the first 8 KB.
const SIGNATURES = ["glTF", "\x89PNG", "GIF8", "RIFF", "\x00asm", "%PDF", "PK\x03\x04", "wOFF", "wOF2", "OTTO", "\x00\x01\x00\x00"];
export function isBinary(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.subarray(0, 8).toString("latin1");
  if (SIGNATURES.some((s) => head.startsWith(s))) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
  if (head.slice(4, 8) === "ftyp") return true; // MP4, AVIF, HEIC
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
