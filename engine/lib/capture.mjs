// Capture: visit the page like one person would (desktop, then phone), keep every response,
// then write the site into site/ so it runs from your own folder: HTML, CSS, scripts, fonts,
// images, the API answers it loaded, and the original source files when the site publishes them.
import fs from "node:fs";
import path from "node:path";
import { launch, newContext, networkTracker, scrollMetrics } from "./browser.mjs";
import { HttpStore, Polite, attachStore } from "./httpstore.mjs";
import { initScript } from "./freeze.mjs";
import { looksLikeBotWall, botWallError, sensitiveForms, refuseSensitive, isTracker } from "./guard.mjs";
import { pageUrl, sameSite, TEMPLATES } from "./project.mjs";
import { hasFlight, withFlight } from "./flight.mjs";
import {
  RemakeError, say, ok, warn, step, writeFile, writeJson, fnv, sha1, bytes, walk,
  EXT_FOR_TYPE, TEXT_EXT, ensureDir, isBinary,
} from "./util.mjs";

const STATIC_EXT = /\.(css|m?js|json|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|m4a|ogg|wav|wasm|glb|gltf|bin|txt|xml|map|webmanifest|pdf|lottie)$/i;
const MEDIA_EXT = /\.(mp4|webm|mov|m4v|mp3|m4a|ogg|wav)$/i;
const ARCHIVED = /^https?:\/\/web\.archive\.org\/web\/(\d+)[a-z_]*\/(.+)$/i;

// In archive mode, the site's own files are answered from the Internet Archive (see attachStore).
export function archiveFor(cfg) {
  return cfg.captureMode === "archive" ? { ts: cfg.archiveTs || "2", own: (h) => sameSite(h, cfg) } : null;
}

// The address a file had on the original site (undoing Internet Archive addresses).
export function canonical(url) {
  const m = ARCHIVED.exec(url);
  if (!m) return url;
  let inner = m[2];
  if (inner.startsWith("//")) inner = "https:" + inner;
  if (!/^https?:\/\//i.test(inner)) inner = "https://" + inner.replace(/^\/+/, "");
  return inner;
}

export function localPath(url, contentType, cfg, taken = new Map()) {
  const u = new URL(canonical(url));
  if (/(^|\.)archive\.org$/i.test(u.host)) return null;
  const same = sameSite(u.host, cfg);
  let p = u.pathname;
  try {
    p = decodeURIComponent(p);
  } catch {}
  p = p.replace(/\/{2,}/g, "/").replace(/[<>:"|*]/g, "_");
  const isHtml = contentType === "text/html";
  if (p.endsWith("/")) p += isHtml ? "index.html" : "index";
  let ext = path.extname(p).toLowerCase();
  const realExt = ext && ext.length <= 6 && /^\.[a-z0-9]+$/.test(ext);
  if (!realExt) {
    if (isHtml) p = p + "/index.html";
    else p += EXT_FOR_TYPE[contentType] || ".bin";
    ext = path.extname(p);
  }
  if (u.search) {
    const keepPlain = same && STATIC_EXT.test(ext);
    if (!keepPlain) p = p.slice(0, p.length - ext.length) + "__" + fnv(u.search) + ext;
  }
  const rel = (same ? "" : `/_ext/${u.host}`) + p;
  if (rel.startsWith("/_remake/")) return null;
  // Same path already used by a different address: give this one its own name.
  const prior = taken.get(rel);
  if (prior && prior !== u.href) return rel.slice(0, rel.length - ext.length) + "__" + fnv(u.href) + ext;
  taken.set(rel, u.href);
  return rel;
}

function classify(entry, cfg) {
  const ct = entry.contentType;
  if (entry.type === "document" && ct === "text/html") return "page";
  if (entry.method !== "GET" || entry.type === "fetch" || entry.type === "xhr") {
    if (/json|text|xml|graphql|javascript/.test(ct) || entry.method === "POST") return "api";
  }
  return "asset";
}

const FRAMEWORK_PROBE = () => {
  const html = document.documentElement.outerHTML.slice(0, 400000);
  const has = (re) => re.test(html);
  const found = [];
  const add = (name, test) => test && found.push(name);
  add("Next.js", !!window.__NEXT_DATA__ || !!self.__next_f || has(/\/_next\/static\//));
  add("Nuxt", !!window.__NUXT__ || has(/\/_nuxt\//));
  add("Astro", has(/astro-island|\/_astro\//));
  add("SvelteKit", has(/__sveltekit|\/_app\/immutable\//));
  add("Gatsby", has(/___gatsby/));
  add("WordPress", has(/\/wp-content\/|\/wp-includes\//));
  add("Webflow", !!window.Webflow || has(/website-files\.com|data-wf-page/));
  add("Framer", has(/framerusercontent\.com|data-framer-/));
  add("Squarespace", has(/squarespace\.com|static1\.squarespace/));
  add("Wix", has(/wixstatic\.com|_wixCIDX|wix-bolt/));
  add("Shopify", !!window.Shopify || has(/cdn\.shopify\.com/));
  add("GSAP", !!window.gsap || !!window.TweenMax || has(/gsap/i));
  add("Lenis", has(/lenis/i));
  add("Locomotive Scroll", has(/locomotive-scroll|data-scroll-container/));
  add("Three.js", !!window.THREE || has(/three(\.module)?(\.min)?\.js/));
  add("Swiper", !!window.Swiper || has(/swiper/i));
  add("Barba", has(/data-barba/));
  add("Swup", has(/swup/i));
  add("Lottie", has(/lottie/i));
  add("Spline", has(/spline-viewer|splinecode/));
  add("hls.js", !!window.Hls || has(/hls(\.min)?\.js/));
  add("jQuery", !!window.jQuery);
  add("React", !!document.querySelector("[data-reactroot]") || !!window.React || has(/react-dom/));
  add("Vue", !!window.Vue || has(/data-v-[0-9a-f]{6,}/));
  return {
    title: document.title,
    frameworks: found,
    canvases: document.querySelectorAll("canvas").length,
    videos: document.querySelectorAll("video").length,
    iframes: [...document.querySelectorAll("iframe[src]")].map((f) => { try { return new URL(f.src).host; } catch (e) { return ""; } }).filter(Boolean),
    fonts: [...new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family.replace(/["']/g, "")} ${f.weight}${f.style === "italic" ? " italic" : ""}`))],
    links: [...document.querySelectorAll("a[href]")].map((a) => ({
      href: a.href,
      nav: !!a.closest("header, nav, [role=navigation]"),
      text: (a.textContent || "").trim().slice(0, 60),
    })),
  };
};

async function visit(browser, store, cfg, url, vp, { archive, renderedFile }) {
  const context = await newContext(browser, vp);
  await context.addInitScript(initScript(cfg.seed));
  let wall = false;
  await attachStore(context, store, {
    archive,
    onDocument: ({ status, html }) => {
      if (looksLikeBotWall(status, html)) {
        wall = true;
        return "block";
      }
    },
  });
  const page = await context.newPage();
  const net = networkTracker(page);
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 120000 });
    if (wall) throw botWallError(url);
    if (res && res.status() >= 400 && !archive) {
      throw new RemakeError(`${url} answered ${res.status()}.`, "Check the address, or try again later.");
    }
    await net.idle(10000);
    refuseSensitive(url, await sensitiveForms(page));
    // Scroll to the bottom and back, so lazy images, scroll scenes and late scripts load.
    await page.mouse.move(vp.width / 2, vp.height / 2);
    const m = await scrollMetrics(page);
    for (let y = 0; y < m.height + vp.height; y += 300) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(110);
    }
    await page.waitForTimeout(1500);
    await net.idle(15000);
    for (let y = 0; y < m.height + vp.height; y += 1200) {
      await page.mouse.wheel(0, -1200);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(1200);
    await net.idle(8000);
    const probe = await page.evaluate(FRAMEWORK_PROBE).catch(() => ({}));
    const after = await scrollMetrics(page);
    if (renderedFile) writeFile(renderedFile, await page.content());
    return { ...probe, height: after.height };
  } finally {
    await context.close();
  }
}

function urlsInText(text) {
  const out = new Set();
  const abs = /(?:https?:)?\\?\/\\?\/[a-z0-9.-]+\.[a-z]{2,}(?:\\?\/[^\s"'`()<>{}\\,]*)?/gi;
  for (const m of text.matchAll(abs)) out.add(m[0].replace(/\\\//g, "/"));
  return out;
}

function refsInMarkup(text, baseUrl) {
  const out = new Set();
  const add = (raw) => {
    if (!raw || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(raw.trim())) return;
    try {
      out.add(new URL(raw.trim().replace(/&amp;/g, "&"), baseUrl).href);
    } catch {}
  };
  for (const m of text.matchAll(/\b(?:src|href|poster|data-src|data-bg|data-background|data-poster|content)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/\b(?:srcset|data-srcset|imagesrcset)\s*=\s*["']([^"']+)["']/gi)) {
    for (const part of m[1].split(",")) add(part.trim().split(/\s+/)[0]);
  }
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]);
  for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) add(m[1]);
  return out;
}

// Script chunks a JavaScript module loads by relative path: import "./x.js", import("../y.js"), "./z.css".
function moduleRefs(text, baseUrl) {
  const out = new Set();
  for (const m of text.matchAll(/["'`](\.{1,2}\/[^"'`\s]+?\.(?:m?js|css|json|wasm))["'`]/g)) {
    try {
      out.add(new URL(m[1], baseUrl).href);
    } catch {}
  }
  return out;
}

function stripTrackers(html) {
  let out = html;
  out = out.replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => (isTracker(src) ? "" : tag));
  // Inline tracker snippets only: matched on how the snippets start, never on words that page data
  // might contain (a blog post about cookie banners names consent tools; removing it breaks the page).
  out = out.replace(/<script\b(?![^>]*\bsrc=)([^>]*)>((?:(?!<\/script>)[\s\S])*?)<\/script>/gi, (tag, attrs, body) => {
    if (/type\s*=\s*["']?application\/(ld\+)?json/i.test(attrs) || /__next_f|__NUXT__|__NEXT_DATA__|self\.__|window\.__remix/.test(body)) return tag;
    const b = body.trim();
    const snippet =
      /^\(function\(w,d,s,l,i\)/.test(b) || // Google Tag Manager
      /^window\.dataLayer\s*=\s*window\.dataLayer\s*\|\|\s*\[\];[\s\S]{0,300}gtag\(/.test(b) || // gtag.js
      /^!function\(f,b,e,v,n,t,s\)/.test(b) || // Meta pixel
      /^\(function\(h,o,t,j,a,r\)/.test(b) || // Hotjar
      /^\(function\(c,l,a,r,i,t,y\)/.test(b) || // Microsoft Clarity
      /^_linkedin_partner_id/.test(b) || // LinkedIn
      /^!function\(t,e\)\{var o,n,p,r;e\.__SV/.test(b) || // PostHog
      /^\(function\(e,t\)\{var r=e\.amplitude/.test(b); // Amplitude
    return snippet && b.length < 6000 ? "" : tag;
  });
  out = out.replace(/<noscript>\s*<iframe[^>]+googletagmanager[^>]*>\s*<\/iframe>\s*<\/noscript>/gi, "");
  out = out.replace(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, (tag, href) => (isTracker(href) ? "" : tag));
  return out;
}

// Undo what the Wayback Machine adds when it replays a page: its toolbar and scripts, its
// address prefixes, the wrapper it puts at the top of every script, and its notes at the bottom.
function unArchive(text) {
  return text
    .replace(/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/g, "")
    .replace(/<script[^>]*src=["'][^"']*\/_static\/[^"']*["'][^>]*>\s*<\/script>/g, "")
    .replace(/<link[^>]*href=["'][^"']*\/_static\/[^"']*["'][^>]*>/g, "")
    .replace(/<script[^>]*>\s*(?:window\.RufflePlayer|__wm\.|var\s+_____WB\$)[\s\S]*?<\/script>/g, "")
    .replace(/var _____WB\$wombat\$assign\$function_____=[\s\S]*?var opener = _____WB\$wombat\$assign\$function_____\("opener"\);\n?/g, "")
    .replace(/(?:let|var) window = _____WB\$wombat\$assign\$function_____[\s\S]*?\("opener"\);\n?/g, "")
    .replace(/_____WB\$wombat\$check\$this\$function_____\(this\)/g, "this")
    .replace(/\/\*\s*FILE ARCHIVED ON[\s\S]*?\*\/\s*/g, "")
    .replace(/\/\*\s*playback timings \(ms\):[\s\S]*?\*\/\s*/g, "")
    .replace(/(?:https?:)?\/\/web\.archive\.org\/web\/\d+[a-z_]*\//g, "")
    .replace(/\/web\/\d{8,14}[a-z_]*\//g, "")
    .replace(/<!--\s*FILE ARCHIVED ON[\s\S]*?-->/g, "")
    .replace(/<!--\s*playback timings[\s\S]*?-->/g, "");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function capture(project, opts = {}) {
  const { cfg, p, save } = project;
  const store = new HttpStore(p.cache);
  const polite = new Polite(store, { interval: cfg.politeInterval, log: (m) => warn(m) });
  const archive = !!opts.archive;
  const browser = await launch();
  const recon = { url: cfg.url, at: new Date().toISOString(), pages: {}, archive };

  const mode = archive ? "archive" : "live";
  const ts = archive ? (opts.archive === true ? "2" : String(opts.archive)) : null;
  // A different source (live vs archive, or another archive date) means the recorded pages and
  // scripts belong to another version of the site: drop them, keep images and fonts.
  if (opts.fresh) {
    store.entries = {};
  } else if (cfg.capturedAt && (cfg.captureMode !== mode || cfg.archiveTs !== ts)) {
    for (const [k, e] of Object.entries(store.entries)) {
      if (e.type === "document" || /\.(m?js|css)(\?|$)/i.test(e.url) || /archive\.org\//.test(e.url) || /html|javascript|css/.test(e.contentType || "")) delete store.entries[k];
    }
  }
  // Archive misses are cheap to ask again (one request each), and the Archive keeps growing.
  if (archive) for (const [k, e] of Object.entries(store.entries)) if (e.source === "archive" && e.status === 404 && e.from === "polite") delete store.entries[k];
  cfg.captureMode = mode;
  cfg.archiveTs = ts;
  fs.rmSync(p.sources, { recursive: true, force: true });
  const target = (pagePath) => pageUrl(cfg, pagePath);
  const archiveOpt = archiveFor(cfg);

  try {
    step(`Visiting ${cfg.url}${archive ? ` (its files answered by the Internet Archive's copy of ${cfg.archiveTs})` : ""}`);
    const pages = [...cfg.pages];
    for (let i = 0; i < pages.length; i++) {
      const pagePath = pages[i];
      const info = {};
      for (const [name, vp] of Object.entries(cfg.viewports)) {
        info[name] = await visit(browser, store, cfg, target(pagePath), vp, {
          archive: archiveOpt,
          renderedFile: path.join(p.rendered, `${fnv(pagePath)}-${name}.html`),
        });
        ok(`${pagePath} at ${vp.width}×${vp.height}: ${info[name].height}px tall`);
      }
      recon.pages[pagePath] = info;
      // Grow the page list from the navigation, up to maxPages.
      if (i === 0 && cfg.maxPages > pages.length) {
        const seen = new Set(pages.map((x) => x.split("#")[0]));
        const links = (info.desktop.links || [])
          .sort((a, b) => Number(b.nav) - Number(a.nav))
          .map((l) => { try { return new URL(canonical(l.href)); } catch { return null; } })
          .filter((u) => u && sameSite(u.host, cfg) && !/\.(pdf|jpe?g|png|zip|mp4|svg)$/i.test(u.pathname))
          .filter((u) => !/(login|signin|sign-in|account|cart|checkout|wp-admin|admin|logout)/i.test(u.pathname))
          .map((u) => u.pathname + u.search);
        for (const l of links) {
          if (pages.length >= cfg.maxPages) break;
          if (!seen.has(l)) {
            seen.add(l);
            pages.push(l);
          }
        }
        cfg.pages = pages;
      }
    }
    store.save();
  } finally {
    await browser.close();
  }

  step("Writing the site into site/");
  const taken = new Map();
  const files = []; // { entry, url, rel, kind, text? }
  const net = {};
  const pagesSet = new Set(cfg.pages.map((x) => new URL(x, cfg.origin).href));
  const ledger = [];
  const streamed = new Set();

  const consider = (entry) => {
    if (entry.status < 200 || entry.status >= 300 || entry.range) return;
    const url = canonical(entry.url);
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (/(^|\.)archive\.org$/i.test(u.host)) return;
    // Streaming video (HLS, DASH) keeps playing from its own host: a partial copy would stall.
    if (/\.(m3u8|ts|m4s|mpd)$/i.test(u.pathname) || /mpegurl|mp2t|dash\+xml/.test(entry.contentType)) {
      if (/\.(m3u8|mpd)$/i.test(u.pathname)) streamed.add(url);
      return;
    }
    let kind = classify(entry, cfg);
    // A binary file fetched by a script (3D model, image, font) is a file, whatever its label says.
    if (kind === "api" && entry.method === "GET" && isBinary(store.body(entry))) kind = "asset";
    if (kind === "page" && !pagesSet.has(url.split("#")[0]) && !sameSite(u.host, cfg)) kind = "asset";
    if (kind === "api") {
      const key = `${entry.method} ${url}${entry.postHash ? " #" + entry.postHash : ""}`;
      const ext = EXT_FOR_TYPE[entry.contentType] || ".txt";
      const rel = `/_remake/net/${sha1(key).slice(0, 12)}${ext}`;
      net[key] = { file: rel, status: entry.status, type: entry.contentType };
      files.push({ entry, url, rel, kind });
      return;
    }
    const rel = localPath(url, entry.contentType, cfg, taken);
    if (!rel) return;
    files.push({ entry, url, rel, kind });
  };
  for (const e of store.all()) consider(e);

  // Load text now; scan it for files the visit never requested (other image sizes, font weights,
  // script chunks a module imports). New scripts and styles get scanned too, a few rounds deep.
  const bodyOf = (f) => f.buffer || store.body(f.entry);
  const have = new Set(files.map((f) => f.url));
  const hosts = new Set(files.filter((x) => x.kind === "asset").map((x) => new URL(x.url).host));
  const wantedFrom = (list) => {
    const wanted = new Set();
    for (const f of list) {
      if ((!TEXT_EXT.test(f.rel) && !/html|css|javascript|json|svg/.test(f.entry.contentType)) || isBinary(bodyOf(f))) continue;
      let text = bodyOf(f).toString("utf8");
      if (archive) text = unArchive(text);
      const refs = new Set([...refsInMarkup(text, f.url), ...urlsInText(text)]);
      if (/\.m?js$/.test(f.rel)) for (const r of moduleRefs(text, f.url)) refs.add(r);
      for (const r of refs) {
        let u;
        try {
          u = new URL(r.startsWith("//") ? "https:" + r : r);
        } catch {
          continue;
        }
        const abs = canonical(u.href);
        if (have.has(abs) || isTracker(abs)) continue;
        const host = new URL(abs).host;
        if (!(sameSite(host, cfg) || hosts.has(host))) continue;
        if (!STATIC_EXT.test(new URL(abs).pathname) || MEDIA_EXT.test(abs) || /\.map$/i.test(abs)) continue;
        wanted.add(abs.split("#")[0]);
      }
    }
    return wanted;
  };
  const fetchExtra = async (url) => {
    const cached = store.find(url);
    if (cached) return cached.status < 400 ? { ...cached, buffer: store.body(cached) } : null;
    if (!archive) return polite.get(url);
    let r = await polite.fromArchive(url, { ts: cfg.archiveTs });
    if (r && r.error) {
      // The Archive was busy: wait and ask once more; never remember a busy answer as "missing".
      await new Promise((ok) => setTimeout(ok, 5000));
      r = await polite.fromArchive(url, { ts: cfg.archiveTs });
      if (r && r.error) return null;
    }
    if (!r) store.put({ url, method: "GET", status: 404, headers: {}, type: "other", source: "archive", from: "polite" }, Buffer.alloc(0));
    return r;
  };
  const cap = Number(opts.maxExtra || 1500);
  let round = files;
  let fetched = 0;
  let asked = 0;
  for (let depth = 0; depth < 6 && round.length && asked < cap; depth++) {
    const extra = [...wantedFrom(round)].slice(0, cap - asked);
    if (!extra.length) break;
    if (depth === 0) say(`  Fetching ${extra.length} files the visit didn't load (other image sizes, font weights, script chunks), one at a time…`);
    else say(`  …and ${extra.length} more that those files point to`);
    const added = [];
    for (const url of extra) {
      asked++;
      have.add(url);
      const r = await fetchExtra(url);
      if (!r) {
        ledger.push({ url, status: "missing" });
        continue;
      }
      const rel = localPath(url, r.contentType, cfg, taken);
      if (!rel) continue;
      const f = { entry: r, url, rel, kind: "asset", buffer: r.buffer };
      files.push(f);
      added.push(f);
      fetched++;
    }
    round = added;
    store.save();
  }
  if (asked) ok(`${fetched} of ${asked} extra files collected`);

  // Video files: download the ones that are plain files and not huge; the rest keep streaming.
  const remoteMedia = new Set(streamed);
  const mediaUrls = new Set([...store.media].map(canonical));
  for (const f of files) {
    if (f.kind !== "page") continue;
    const html = bodyOf(f).toString("utf8");
    for (const r of refsInMarkup(html, f.url)) if (MEDIA_EXT.test(new URL(r).pathname) || /\.m3u8/i.test(r)) mediaUrls.add(canonical(r));
  }
  const maxMedia = Number(opts.maxMediaMb || 60) * 1024 * 1024;
  for (const url of mediaUrls) {
    if (have.has(url)) continue;
    const plain = MEDIA_EXT.test(new URL(url).pathname);
    const r = plain && !opts.noMedia ? await polite.get(url, { type: "media", maxBytes: maxMedia }) : null;
    if (r && r.buffer) {
      const rel = localPath(url, r.contentType, cfg, taken);
      if (rel) {
        files.push({ entry: r, url, rel, kind: "asset", buffer: r.buffer });
        have.add(url);
        continue;
      }
    }
    remoteMedia.add(url);
  }

  const rewrite = buildRewriter(
    cfg,
    files.filter((f) => f.kind !== "api").map((f) => [f.url, f.rel]),
    remoteMedia,
    archive,
  );

  // Clear the previous capture (but keep the proof and swap pages).
  for (const entry of fs.existsSync(p.site) ? fs.readdirSync(p.site) : []) {
    if (entry !== "_remake") fs.rmSync(path.join(p.site, entry), { recursive: true, force: true });
  }
  fs.rmSync(path.join(p.site, "_remake", "net"), { recursive: true, force: true });

  let total = 0;
  const counts = {};
  for (const f of files) {
    const out = path.join(p.site, f.rel);
    let buf = bodyOf(f);
    const isText = (TEXT_EXT.test(f.rel) || /html|css|javascript|json|svg|xml/.test(f.entry.contentType)) && !isBinary(buf);
    if (isText) buf = Buffer.from(rewrite(buf.toString("utf8"), f.rel.endsWith(".html") && f.kind === "page"), "utf8");
    // A directory and a file can't share a name; keep the first and note the other.
    try {
      writeFile(out, buf);
    } catch {
      ledger.push({ url: f.url, status: "path-conflict", local: f.rel });
      continue;
    }
    total += buf.length;
    const k = f.kind === "page" ? "pages" : f.kind === "api" ? "api" : typeOf(f);
    counts[k] = (counts[k] || 0) + 1;
    ledger.push({
      url: f.url,
      local: f.rel,
      kind: k,
      contentType: f.entry.contentType,
      size: buf.length,
      source: ARCHIVED.test(f.entry.url || "") ? "archive" : f.entry.source || "live",
    });
  }
  for (const m of remoteMedia) ledger.push({ url: m, status: "streams-from-original", kind: "media" });

  const runtime = fs
    .readFileSync(path.join(TEMPLATES, "runtime.js"), "utf8")
    .replace("/*__REMAKE_CONFIG__*/ { origin: \"\", pages: [], net: {} }", JSON.stringify({ origin: cfg.origin, pages: cfg.pages, net }));
  writeFile(path.join(p.site, "_remake", "runtime.js"), runtime);

  // Source maps: the site's original source files, when it publishes them.
  const maps = await sourceMaps(files, store, polite, p, opts);

  const archived = ledger.filter((l) => l.source === "archive").length;
  recon.stats = { files: ledger.filter((l) => l.local).length, bytes: total, counts, archived, sourceMaps: maps };
  recon.trackersRemoved = [...store.trackers];
  recon.streaming = [...remoteMedia];
  recon.blockedHosts = [...store.blocked];
  writeJson(p.recon, recon);
  writeJson(p.ledger, ledger);
  cfg.capturedAt = new Date().toISOString();
  save();

  const first = recon.pages[cfg.pages[0]]?.desktop || {};
  step(`Captured ${cfg.host}`);
  say(`  pages      ${cfg.pages.length} (${cfg.pages.join(", ")})`);
  say(`  files      ${recon.stats.files} (${bytes(total)})${archived ? `, ${archived} from the Internet Archive` : ""}`);
  say(`  kinds      ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ")}`);
  if (maps.files) say(`  source     ${maps.maps} source maps → ${maps.files} original files in remake/sources/`);
  if (recon.trackersRemoved.length) say(`  removed    ${recon.trackersRemoved.length} trackers (${recon.trackersRemoved.slice(0, 5).join(", ")})`);
  const pageHtml = files.filter((f) => f.kind === "page").map((f) => bodyOf(f).toString("utf8")).join("\n");
  const namedStreams = [...remoteMedia].filter((m) => pageHtml.includes(m) || pageHtml.includes(new URL(m).pathname.split("/").slice(0, -1).join("/") + "/")).length;
  if (remoteMedia.size) say(`  streaming  ${namedStreams || remoteMedia.size} videos still play from the original's servers`);
  if (store.blocked.size) warn(`blocked us: ${[...store.blocked].join(", ")}. Missing files came from the Internet Archive where possible.`);
  if (first.frameworks?.length) say(`  built with ${first.frameworks.join(", ")}${first.canvases ? `, ${first.canvases} canvas` : ""}`);
  const missing = ledger.filter((l) => l.status === "missing").length;
  if (missing) warn(`${missing} referenced files couldn't be fetched (listed in remake/ledger.json).`);
  say("\nNext: remake score");
  return recon;
}

// Rewrites addresses inside HTML, CSS, JS and JSON so every file loads from your copy.
export function buildRewriter(cfg, pairs, remoteMedia = new Set(), archive = false) {
  const swaps = [];
  const hostVariants = [cfg.host, cfg.host.startsWith("www.") ? cfg.host.slice(4) : "www." + cfg.host];
  for (const [url, rel] of pairs) {
    const u = new URL(url);
    const same = sameSite(u.host, cfg);
    if (same && decodeURIComponentSafe(u.pathname) === rel) continue; // same path at home: nothing to rewrite
    // Pages and folder addresses are prefixes of every other address: never swap them as strings.
    if (rel.endsWith("/index.html") || /\/$/.test(u.pathname) && !u.search) continue;
    const forms = new Set([url, url.replace(/^https?:/, ""), url.replace(/&/g, "&amp;")]);
    if (same) {
      forms.add(u.pathname + u.search);
      forms.add((u.pathname + u.search).replace(/&/g, "&amp;"));
    }
    for (const from of forms) {
      if (!from || from === "/") continue;
      swaps.push([from, rel]);
      swaps.push([from.replace(/\//g, "\\/"), rel.replace(/\//g, "\\/")]);
    }
  }
  swaps.sort((a, b) => b[0].length - a[0].length);

  const rewriteBody = (input) => {
    let out = input;
    for (const [from, to] of swaps) if (out.includes(from)) out = out.split(from).join(to);
    // Every other address on the original's own domain becomes a path on yours.
    // Same rule in markup and in page data (they must agree, or React re-renders the page):
    // https://site.com/x → /x, and a bare https://site.com → /
    for (const h of hostVariants) {
      const hre = escapeRe(h);
      out = out.replace(new RegExp(`(?:https?:)?\\/\\/${hre}(?=/)`, "gi"), "");
      out = out.replace(new RegExp(`(?:https?:)?\\/\\/${hre}(?=["'\\s)?#]|$)`, "gi"), "/");
      out = out.replace(new RegExp(`(?:https?:)?\\\\\\/\\\\\\/${hre}(?=\\\\\\/)`, "gi"), "");
    }
    // Streams and large videos still play from the original address.
    for (const m of remoteMedia) {
      const u = new URL(m);
      if (!sameSite(u.host, cfg)) continue;
      const rel = u.pathname + u.search;
      out = out.split(`"${rel}"`).join(`"${m}"`).split(`'${rel}'`).join(`'${m}'`).split(`(${rel})`).join(`(${m})`);
    }
    return out;
  };

  return (text, isHtml) => {
    let out = archive ? unArchive(text) : text;
    // Next.js page data is rewritten row by row so its byte lengths stay right.
    out = isHtml && hasFlight(out) ? withFlight(out, (row) => rewriteBody(row), rewriteBody) : rewriteBody(out);
    if (isHtml) {
      out = stripTrackers(out);
      out = out.replace(/\s+integrity\s*=\s*(["'])[^"']*\1/gi, "");
      out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
      if (!out.includes("/_remake/runtime.js")) {
        const inject = '<script src="/_remake/runtime.js"></script><meta name="robots" content="noindex, nofollow">';
        out = /<head\b[^>]*>/i.test(out) ? out.replace(/<head\b[^>]*>/i, (m) => m + inject) : inject + out;
      }
    }
    return out;
  };
}

// Files the remake asked for that weren't captured (logged by the local server): fetch them politely.
export async function fetchMissing(project, urls = []) {
  const { cfg, p } = project;
  const store = new HttpStore(p.cache);
  const polite = new Polite(store, { interval: cfg.politeInterval, log: (m) => warn(m) });
  const ledger = JSON.parse(fs.existsSync(p.ledger) ? fs.readFileSync(p.ledger, "utf8") : "[]");
  const fromLog = fs.existsSync(p.missing) ? fs.readFileSync(p.missing, "utf8").split("\n").filter(Boolean) : [];
  const targets = new Set(urls);
  for (const req of fromLog) {
    const pathPart = req.split("#")[0];
    if (/^\/_remake\//.test(pathPart) || /__[0-9a-f]{8}\./.test(pathPart)) continue;
    const ext = /^\/_ext\/([^/]+)(\/.*)$/.exec(pathPart);
    targets.add(ext ? `https://${ext[1]}${ext[2]}` : cfg.origin + pathPart);
  }
  if (!targets.size) {
    say("Nothing missing: the local server hasn't logged any 404s. Open the remake, click around, then run this again.");
    return;
  }
  step(`Fetching ${targets.size} missing files, one at a time`);
  const taken = new Map(ledger.filter((l) => l.local).map((l) => [l.local, l.url]));
  const rewrite = buildRewriter(cfg, ledger.filter((l) => l.local && l.url).map((l) => [l.url, l.local]), new Set(), cfg.captureMode === "archive");
  let got = 0;
  for (const url of targets) {
    if (isTracker(url)) continue;
    const r = cfg.captureMode === "archive" ? await polite.fromArchive(url) : await polite.get(url);
    if (!r) {
      warn(`not found: ${url}`);
      continue;
    }
    const rel = localPath(url, r.contentType, cfg, taken);
    if (!rel) continue;
    let buf = r.buffer;
    if (TEXT_EXT.test(rel) && !isBinary(buf)) buf = Buffer.from(rewrite(buf.toString("utf8"), false), "utf8");
    writeFile(path.join(p.site, rel), buf);
    ledger.push({ url, local: rel, kind: "fetched-later", contentType: r.contentType, size: buf.length, source: r.source || "live" });
    got++;
  }
  store.save();
  writeJson(p.ledger, ledger);
  fs.writeFileSync(p.missing, "");
  ok(`${got} of ${targets.size} fetched`);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function typeOf(f) {
  const ct = f.entry.contentType || "";
  if (/css/.test(ct) || f.rel.endsWith(".css")) return "styles";
  if (/javascript/.test(ct) || /\.m?js$/.test(f.rel)) return "scripts";
  if (/font/.test(ct) || /\.(woff2?|ttf|otf|eot)$/.test(f.rel)) return "fonts";
  if (/image/.test(ct) || /\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(f.rel)) return "images";
  if (/video|audio/.test(ct) || MEDIA_EXT.test(f.rel)) return "media";
  return "other";
}

async function sourceMaps(files, store, polite, p, opts) {
  if (opts.noSourceMaps) return { maps: 0, files: 0 };
  let maps = 0;
  let written = 0;
  const done = new Set();
  for (const f of files) {
    if (!/\.(m?js|css)$/.test(f.rel)) continue;
    const text = (f.buffer || store.body(f.entry)).toString("utf8");
    const m = /[#@]\s*sourceMappingURL=([^\s'"*]+)\s*(?:\*\/)?\s*$/.exec(text.slice(-2000));
    if (!m) continue;
    let json;
    try {
      if (m[1].startsWith("data:")) {
        json = JSON.parse(Buffer.from(m[1].split(",")[1], m[1].includes("base64") ? "base64" : "utf8").toString("utf8"));
      } else {
        const mapUrl = new URL(m[1], f.url).href;
        if (done.has(mapUrl) || done.size >= 300) continue;
        done.add(mapUrl);
        const r = await polite.get(mapUrl, { expectHtml: false });
        if (!r) continue;
        json = JSON.parse(r.buffer.toString("utf8"));
      }
    } catch {
      continue;
    }
    if (!json || !Array.isArray(json.sources) || !Array.isArray(json.sourcesContent)) continue;
    maps++;
    const host = new URL(f.url).host;
    json.sources.forEach((src, i) => {
      const content = json.sourcesContent[i];
      if (!content || /node_modules/.test(src)) return;
      const clean = src.replace(/^[a-z]+:\/\/\/?/i, "").replace(/^(\.\.\/|\.\/)+/, "").replace(/[?#].*$/, "").replace(/[<>:"|*]/g, "_");
      writeFile(path.join(p.sources, host, clean), content);
      written++;
    });
  }
  return { maps, files: written };
}
