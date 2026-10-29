// A remake project: the site/ folder that gets deployed, and the remake/ folder of working files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemakeError, ensureDir, readJson, writeJson, slugify, UA_SUFFIX } from "./util.mjs";

export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATES = path.join(ENGINE_ROOT, "templates");

export const DEFAULTS = {
  viewports: {
    desktop: { width: 1440, height: 900, isMobile: false },
    phone: { width: 390, height: 844, isMobile: true },
  },
  // A screen passes when this share of its stable pixels matches the original.
  thresholds: { screen: 98, motion: 95 },
  // Everything random or timed starts from these, on both sides.
  seed: 1337,
  epoch: Date.UTC(2026, 0, 1, 12, 0, 0),
  settleMs: 6000,
  scrollSettleMs: 1500,
  motionFrames: 24,
  // Seconds between extra requests to one host, after the first visit (one at a time, never in parallel).
  politeInterval: 0.5,
};

export function paths(root) {
  const work = path.join(root, "remake");
  return {
    root,
    site: path.join(root, "site"),
    work,
    config: path.join(work, "remake.json"),
    cache: path.join(work, ".cache", "http"),
    original: path.join(work, "original"),
    scoreDir: path.join(work, "score"),
    rendered: path.join(work, "rendered"),
    sources: path.join(work, "sources"),
    ledger: path.join(work, "ledger.json"),
    recon: path.join(work, "recon.json"),
    score: path.join(work, "score.json"),
    content: path.join(work, "content.json"),
    ship: path.join(work, "ship.json"),
    accepted: path.join(work, "accepted.json"),
    missing: path.join(work, "missing.log"),
    report: path.join(root, "REPORT.md"),
    roadmap: path.join(root, "MAKE-IT-YOURS.md"),
    remakeSite: path.join(root, "site", "_remake"),
  };
}

export function loadProject(dir = process.cwd()) {
  let root = path.resolve(dir);
  // Walk up so commands work from any folder inside the project.
  while (!fs.existsSync(path.join(root, "remake", "remake.json"))) {
    const up = path.dirname(root);
    if (up === root) {
      throw new RemakeError(
        "No remake project here.",
        "Run `remake init <url>` first, or pass --dir <project folder>.",
      );
    }
    root = up;
  }
  const p = paths(root);
  const cfg = { ...DEFAULTS, ...readJson(p.config, {}) };
  cfg.viewports = { ...DEFAULTS.viewports, ...(cfg.viewports || {}) };
  cfg.thresholds = { ...DEFAULTS.thresholds, ...(cfg.thresholds || {}) };
  return { root, p, cfg, save: () => writeJson(p.config, cfg) };
}

export function sameSite(host, cfg) {
  const strip = (h) => h.replace(/^www\./, "");
  return strip(host) === strip(cfg.host);
}

export function pageUrl(cfg, pagePath) {
  return new URL(pagePath, cfg.origin).href;
}

export async function resolveStart(url) {
  // One plain request to learn the final address after redirects (http → https, apex → www).
  let target = url;
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  try {
    const res = await fetch(target, {
      redirect: "follow",
      headers: { "user-agent": `Mozilla/5.0 ${UA_SUFFIX}` },
      signal: AbortSignal.timeout(30000),
    });
    return { url: res.url || target, status: res.status };
  } catch (e) {
    return { url: target, status: 0, error: e.message };
  }
}

export async function initProject(url, opts = {}) {
  const start = await resolveStart(url);
  const u = new URL(start.url);
  const name = opts.name || slugify(u.host + (u.pathname.length > 1 ? "-" + u.pathname : ""));
  const root = path.resolve(opts.dir || path.join(os.homedir(), "remakes", name));
  const p = paths(root);
  if (fs.existsSync(p.config) && !opts.force) {
    return { root, p, cfg: readJson(p.config), existed: true, start };
  }
  ensureDir(p.site);
  ensureDir(p.work);
  const cfg = {
    ...DEFAULTS,
    url: u.href,
    origin: u.origin,
    host: u.host,
    name,
    pages: [u.pathname + u.search],
    maxPages: Number(opts.pages || 1),
    createdAt: new Date().toISOString(),
  };
  writeJson(p.config, cfg);
  copyTemplates(root, { name, url: u.href });
  return { root, p, cfg, existed: false, start };
}

export function copyTemplates(root, vars) {
  const src = path.join(TEMPLATES, "project");
  for (const file of fs.readdirSync(src)) {
    const to = path.join(root, file === "gitignore" ? ".gitignore" : file);
    if (fs.existsSync(to)) continue;
    let text = fs.readFileSync(path.join(src, file), "utf8");
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
    fs.writeFileSync(to, text);
  }
}
