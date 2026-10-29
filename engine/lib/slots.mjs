// Slots: every piece of the original that makes it theirs (copy, photos, videos, fonts, logos,
// links, forms, colours), listed in remake/content.json with where it lives in the files.
// Fill a slot's "swap" field and `remake apply` puts yours in its place without touching the layout.
import fs from "node:fs";
import path from "node:path";
import { parse } from "parse5";
import { launch, newContext } from "./browser.mjs";
import { startServer } from "./serve.mjs";
import { imageSize, renderInto, wrapAsSvg, clipFromImage } from "./imaging.mjs";
import { HttpStore, Polite } from "./httpstore.mjs";
import { sameSite } from "./project.mjs";
import { RemakeError, say, ok, warn, step, walk, readJson, writeJson, writeFile, fnv, ensureDir } from "./util.mjs";
import { hasFlight, withFlight, replaceInRow } from "./flight.mjs";

const BLOCKISH = new Set([
  "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "section", "article", "header", "footer", "nav",
  "table", "tr", "td", "th", "form", "figure", "figcaption", "blockquote", "main", "aside", "dl", "dt", "dd",
  "button", "label", "summary", "details", "address", "pre", "option", "title", "a", "legend", "caption",
]);
const SKIP = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "canvas", "video", "audio", "object", "code", "head"]);
const TEXT_ATTRS = new Set(["alt", "title", "placeholder", "aria-label"]);
// Visible words that sites keep in data attributes (rotating taglines, tooltips, captions).
const DATA_TEXT = /^data-(labels?|titles?|texts?|captions?|tooltips?|messages?|words|phrases|placeholder)$/;
const META_TEXT = /^(description|og:title|og:description|twitter:title|twitter:description|og:site_name)$/i;
const SOCIAL = /(linkedin|instagram|twitter\.com|x\.com|facebook|youtube|youtu\.be|tiktok|github|dribbble|behance|threads\.net|pinterest|vimeo|medium\.com|substack|bsky)/i;
const BOOKING = /(calendly|cal\.com|savvycal|tidycal|meetings\.hubspot|zcal|acuityscheduling)/i;
const FREE_FONTS = /^(inter|roboto|open sans|lato|montserrat|poppins|source sans|source serif|ibm plex|noto|work sans|dm sans|dm serif|manrope|space grotesk|space mono|playfair|merriweather|nunito|raleway|rubik|karla|fira|jetbrains mono|outfit|plus jakarta|figtree|geist|archivo|barlow|oswald|pt sans|pt serif|libre|eb garamond|cormorant|syne|sora|urbanist|lexend|instrument|schibsted|bricolage|unbounded|sometype)/i;

export const norm = (s) => String(s).replace(/\s+/g, " ").trim();
const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeText(s).replace(/"/g, "&quot;");

function textOf(node) {
  if (node.nodeName === "#text") return node.value;
  if (!node.childNodes || SKIP.has(node.nodeName)) return "";
  return node.childNodes.map(textOf).join("");
}

function hasBlockText(node) {
  if (!node.childNodes || SKIP.has(node.nodeName)) return false;
  return node.childNodes.some((c) => c.tagName && !SKIP.has(c.tagName) && ((BLOCKISH.has(c.tagName) && norm(textOf(c))) || hasBlockText(c)));
}

function attr(node, name) {
  return node.attrs?.find((a) => a.name === name)?.value;
}

function sectionLabel(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const n = stack[i];
    if (["header", "footer", "nav", "section", "main", "article", "aside"].includes(n.tagName) || attr(n, "id")) {
      const id = attr(n, "id");
      const cls = (attr(n, "class") || "").split(/\s+/).filter(Boolean)[0];
      return `${n.tagName}${id ? "#" + id : cls ? "." + cls : ""}`;
    }
  }
  return "page";
}

function attrValueRange(html, loc) {
  // loc spans name="value"; find the value inside it.
  const raw = html.slice(loc.startOffset, loc.endOffset);
  const eq = raw.indexOf("=");
  if (eq < 0) return null;
  let s = eq + 1;
  while (/\s/.test(raw[s])) s++;
  const q = raw[s];
  if (q === '"' || q === "'") return { start: loc.startOffset + s + 1, end: loc.endOffset - 1 };
  return { start: loc.startOffset + s, end: loc.endOffset };
}

// Walk one HTML file and collect text blocks, text attributes, links, forms, inline SVG logos, media.
export function scanHtml(html, file) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const found = { text: [], attrs: [], links: [], forms: [], svgs: [], media: [], images: [] };
  const stack = [];
  let lock = 0; // inside a text slot: keep collecting links and images, not more text
  const visit = (node) => {
    if (node.nodeName === "#text") return;
    const tag = node.tagName;
    if (tag) {
      const loc = node.sourceCodeLocation;
      const section = sectionLabel(stack);
      for (const a of node.attrs || []) {
        const aloc = loc?.attrs?.[a.name];
        if (!aloc) continue;
        const range = attrValueRange(html, aloc);
        if (!range) continue;
        if (TEXT_ATTRS.has(a.name) && norm(a.value).length > 1) found.attrs.push({ name: a.name, value: norm(a.value), file, ...range, section });
        if (DATA_TEXT.test(a.name) && /[a-z]{2,}\s+[a-z]{2,}/i.test(a.value) && !/^[{[]|https?:/.test(a.value.trim())) {
          found.attrs.push({ name: a.name, value: norm(a.value), file, ...range, section });
        }
        if (tag === "meta" && a.name === "content" && META_TEXT.test(attr(node, "name") || attr(node, "property") || "")) {
          found.attrs.push({ name: "meta " + (attr(node, "name") || attr(node, "property")), value: norm(a.value), file, ...range, section: "head" });
        }
        if (tag === "a" && a.name === "href") found.links.push({ href: a.value, text: norm(textOf(node)).slice(0, 80), file, ...range, section });
        if (tag === "form" && a.name === "action") found.forms.push({ action: a.value, file, ...range, section });
        if ((tag === "video" || tag === "source" || tag === "audio") && /^(src|poster|data-src)$/.test(a.name)) found.media.push({ attr: a.name, value: a.value, file, section });
        if (tag === "img" && /^(src|data-src)$/.test(a.name)) found.images.push({ src: a.value, alt: attr(node, "alt") || "", section, cls: attr(node, "class") || "" });
      }
      if (tag === "form" && !attr(node, "action")) found.forms.push({ action: "", file, section, start: null });
      // An inline SVG is a logo when it, or one of its three nearest wrappers, says so (class, id, label).
      const near = [node, ...stack.slice(-3)].map((n) => `${attr(n, "class") || ""} ${attr(n, "id") || ""} ${attr(n, "aria-label") || ""}`).join(" ");
      if (tag === "svg" && loc && /logo|brand/i.test(near + " " + section)) {
        found.svgs.push({ file, start: loc.startOffset, end: loc.endOffset, section, size: loc.endOffset - loc.startOffset });
      }
      if (SKIP.has(tag) && tag !== "head") return;
      if (tag === "head") {
        // only <title> and metas matter in head
        stack.push(node);
        for (const c of node.childNodes || []) if (c.tagName === "title" || c.tagName === "meta") visit(c);
        stack.pop();
        return;
      }
      const text = lock ? "" : norm(textOf(node));
      if (text && BLOCKISH.has(tag) && !hasBlockText(node) && loc?.startTag && loc?.endTag) {
        // The text nodes inside the block: swaps change these and keep any markup around them
        // (spans, icons, counters that the site's scripts animate).
        const nodes = [];
        const collect = (n) => {
          if (n.nodeName === "#text") {
            if (n.value.trim() && n.sourceCodeLocation) nodes.push({ start: n.sourceCodeLocation.startOffset, end: n.sourceCodeLocation.endOffset });
            return;
          }
          if (SKIP.has(n.tagName)) return;
          for (const c of n.childNodes || []) collect(c);
        };
        collect(node);
        found.text.push({ value: text, file, start: loc.startTag.endOffset, end: loc.endTag.startOffset, mode: "inner", tag, section, nodes });
        lock++;
        stack.push(node);
        for (const c of node.childNodes || []) visit(c);
        stack.pop();
        lock--;
        return;
      }
      if (text && hasBlockText(node)) {
        // Mixed content: loose text next to blocks becomes its own slot.
        for (const c of node.childNodes) {
          if (c.nodeName === "#text" && norm(c.value).length > 1 && c.sourceCodeLocation) {
            found.text.push({ value: norm(c.value), file, start: c.sourceCodeLocation.startOffset, end: c.sourceCodeLocation.endOffset, mode: "node", tag, section });
          }
        }
      }
    }
    stack.push(node);
    for (const c of node.childNodes || []) visit(c);
    stack.pop();
  };
  visit(doc);
  return found;
}

function cssScan(css) {
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/gi)) {
    const body = m[1];
    const family = (/font-family\s*:\s*["']?([^;"']+)["']?/i.exec(body) || [])[1];
    if (!family) continue;
    const weight = (/font-weight\s*:\s*([^;]+)/i.exec(body) || [])[1]?.trim() || "400";
    const style = (/font-style\s*:\s*([^;]+)/i.exec(body) || [])[1]?.trim() || "normal";
    const srcs = [...body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((x) => x[1]);
    faces.push({ family: family.trim(), weight, style, srcs });
  }
  const colors = {};
  for (const m of css.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\(\s*\d[\d\s,.%/]{4,40}\)|hsla?\(\s*\d[\d\s,.%/deg]{4,40}\)/gi)) {
    let c = m[0].toLowerCase().replace(/\s+/g, "");
    if (/^#[0-9a-f]{3}$/.test(c)) c = "#" + [...c.slice(1)].map((x) => x + x).join("");
    colors[c] = (colors[c] || 0) + 1;
  }
  // Tailwind-style colour variables: --brand: 255 90 31;
  const channels = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*(?=[;}])/g)) {
    if ([m[2], m[3], m[4]].every((v) => +v <= 255)) channels[m[1]] = `${m[2]} ${m[3]} ${m[4]}`;
  }
  return { faces, colors, channels };
}

const variantBase = (rel) =>
  rel
    .replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "")
    .replace(/-scaled(?=\.[a-z0-9]+$)/i, "")
    .replace(/@\dx(?=\.[a-z0-9]+$)/i, "")
    .replace(/__[0-9a-f]{8}(?=\.[a-z0-9]+$)/i, "")
    .replace(/\.(webp|avif)$/i, ".img")
    .replace(/\.(jpe?g|png)$/i, ".img");

// What each image looks like on the rendered page: shown or not, how big, where.
async function renderedUsage(server, cfg, pagePath) {
  const browser = await launch();
  try {
    const context = await newContext(browser, cfg.viewports.desktop);
    const page = await context.newPage();
    await page.goto(server.url + pagePath, { waitUntil: "load", timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const usage = await page.evaluate(() => {
      const out = [];
      const sect = (el) => {
        const s = el.closest("header, footer, nav, section, main, article, aside, [id]");
        return s ? s.tagName.toLowerCase() + (s.id ? "#" + s.id : "") : "page";
      };
      for (const img of document.querySelectorAll("img")) {
        const r = img.getBoundingClientRect();
        const src = img.currentSrc || img.src;
        if (src) out.push({ src: new URL(src, location.href).pathname, w: Math.round(r.width), h: Math.round(r.height), alt: img.alt, section: sect(img), inHeader: !!img.closest("header, nav") });
      }
      for (const el of document.querySelectorAll("body *")) {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === "none") continue;
        for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
          const r = el.getBoundingClientRect();
          try {
            out.push({ src: new URL(m[1], location.href).pathname, w: Math.round(r.width), h: Math.round(r.height), alt: "", section: sect(el), bg: true });
          } catch (e) {}
        }
      }
      const texts = [];
      for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,a,button,span,div,label,figcaption,blockquote")) {
        if (el.children.length && [...el.children].some((c) => getComputedStyle(c).display !== "inline")) continue;
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        const r = el.getBoundingClientRect();
        if (t.length > 2 && t.length < 400 && r.width > 0 && r.height > 0) texts.push(t);
      }
      return { images: out, texts: [...new Set(texts)] };
    });
    await context.close();
    return usage;
  } finally {
    await browser.close();
  }
}

export async function slots(project) {
  const { cfg, p } = project;
  if (!cfg.capturedAt) throw new RemakeError("Nothing captured yet.", "Run `remake capture` first.");
  step("Listing everything that makes this site theirs");
  const prev = readJson(p.content, { slots: [] });
  const keep = new Map(prev.slots.map((s) => [s.id, s]));
  const htmlFiles = walk(p.site, (f) => f.endsWith(".html") && !f.includes(`${path.sep}_remake${path.sep}`));
  const textFiles = walk(p.site, (f) => /\.(m?js|json)$/.test(f) && !f.includes(`${path.sep}_remake${path.sep}runtime`));
  const cssFiles = walk(p.site, (f) => f.endsWith(".css"));
  const rel = (f) => path.relative(project.root, f);
  const bySlot = new Map();
  const add = (id, base, loc) => {
    if (!bySlot.has(id)) bySlot.set(id, { id, ...base, where: [] });
    if (loc) bySlot.get(id).where.push(loc);
  };
  const scans = [];
  const remade = new Set(["/", ...(cfg.pages || []).map((pg) => pg.replace(/\/+$/, "") || "/")]);
  for (const f of htmlFiles) {
    const html = fs.readFileSync(f, "utf8");
    const s = scanHtml(html, rel(f));
    scans.push(s);
    for (const t of s.text) add("t-" + fnv(t.value), { kind: "text", group: groupForText(t), value: t.value, section: t.section, tag: t.tag }, { file: t.file, mode: t.mode });
    for (const a of s.attrs) {
      const group = a.name.startsWith("meta") ? "Search & sharing" : a.name.startsWith("data-") ? "Buttons & menus" : "Image descriptions";
      add("a-" + fnv(a.name + a.value), { kind: "attr", group, attr: a.name, value: a.value, section: a.section }, { file: a.file });
    }
    for (const l of s.links) {
      let u;
      try {
        u = new URL(l.href, cfg.origin);
      } catch {
        continue;
      }
      const external = !sameSite(u.host, cfg) || /^(mailto|tel):/i.test(l.href);
      // A link to one of the site's other pages that wasn't remade leads nowhere on the copy: list it too.
      const missingPage = !external && !remade.has(u.pathname.replace(/\/+$/, "") || "/") && !/\.[a-z0-9]{2,5}$/i.test(u.pathname);
      if (!external && !missingPage) continue;
      const category = missingPage ? "Pages not remade" : /^mailto:/i.test(l.href) ? "Email" : /^tel:/i.test(l.href) ? "Phone" : BOOKING.test(u.host) ? "Booking" : SOCIAL.test(u.host) ? "Social" : "Other links";
      add("l-" + fnv(l.href), { kind: "link", group: "Links & contact", category, value: l.href, label: l.text, section: l.section }, { file: l.file });
    }
    for (const fm of s.forms) add("f-" + fnv(fm.file + fm.section + fm.action), { kind: "form", group: "Links & contact", value: fm.action || "(no address)", section: fm.section }, { file: fm.file });
    for (const sv of s.svgs) add("s-" + fnv(html.slice(sv.start, sv.end)), { kind: "svg", group: "Logos", value: `inline SVG in ${sv.section}`, section: sv.section, size: sv.size }, { file: sv.file });
  }

  // Text that only exists inside scripts or JSON (pages drawn by JavaScript).
  const server = await startServer(p.site);
  let usage = { images: [], texts: [] };
  try {
    usage = await renderedUsage(server, cfg, cfg.pages[0]);
  } catch (e) {
    warn(`couldn't open the remake to see what's on screen: ${e.message}`);
  } finally {
    await server.close();
  }
  const known = new Set([...bySlot.values()].filter((s) => s.kind === "text").map((s) => s.value));
  const scriptTexts = usage.texts.filter((t) => !known.has(t) && ![...known].some((k) => k.includes(t))).slice(0, 400);
  if (scriptTexts.length) {
    const contents = textFiles.map((f) => ({ f, s: fs.readFileSync(f, "utf8") }));
    for (const t of scriptTexts) {
      const needles = [JSON.stringify(t), `'${t.replace(/'/g, "\\'")}'`, "`" + t + "`"];
      for (const { f, s } of contents) {
        const needle = needles.find((n) => s.includes(n));
        if (needle) add("t-" + fnv(t), { kind: "text", group: "Copy", value: t, section: "drawn by script", tag: "script" }, { file: rel(f), mode: "literal", needle });
      }
    }
  }

  // Images: group size variants of one picture into one slot.
  const ledger = readJson(p.ledger, []);
  const images = ledger.filter((l) => l.kind === "images" && l.local);
  const groups = new Map();
  for (const im of images) {
    const key = variantBase(im.local);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(im);
  }
  const ogImages = new Set(scans.flatMap((s) => s.attrs.filter((a) => /og:image|twitter:image/.test(a.name)).map((a) => a.value)));
  for (const [key, list] of groups) {
    const files = list.map((l) => l.local);
    const main = list.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a));
    const buf = fs.readFileSync(path.join(p.site, main.local));
    const dims = imageSize(buf, main.local);
    const used = usage.images.filter((u) => files.some((f) => decodeURIComponent(u.src) === f));
    const htmlRefs = scans.flatMap((s) => s.images).filter((i) => files.some((f) => i.src.includes(path.basename(f))));
    const alt = used.find((u) => u.alt)?.alt || htmlRefs.find((r) => r.alt)?.alt || "";
    const hint = (key + " " + alt + " " + htmlRefs.map((r) => r.cls).join(" ")).toLowerCase();
    let role = "Photos";
    if (/favicon|apple-touch|icon-\d+|android-chrome/.test(hint)) role = "Icons";
    else if (/logo/.test(hint) || (main.local.endsWith(".svg") && used.some((u) => u.inHeader && u.h < 120))) role = "Logos";
    else if (main.local.endsWith(".svg") && dims && dims.width <= 64) role = "Icons";
    add("i-" + fnv(key), {
      kind: "image",
      group: role,
      value: main.local,
      files,
      width: dims?.width || null,
      height: dims?.height || null,
      alt,
      shown: used.length > 0,
      section: used[0]?.section || htmlRefs[0]?.section || "",
      source: main.source,
    });
  }

  // Images the pages point to that the copy doesn't have (the original's server or the Archive
  // never gave them). They show as broken images: list them so a swap fills them.
  const missingGroups = new Map();
  for (const f of htmlFiles) {
    const html = fs.readFileSync(f, "utf8");
    const refs = new Set();
    for (const m of html.matchAll(/\b(?:src|data-src|poster)\s*=\s*["'](\/[^"'?#]+\.(?:jpe?g|png|webp|avif|gif))["']/gi)) refs.add(m[1]);
    for (const m of html.matchAll(/\b(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi)) {
      for (const part of m[1].split(",")) {
        const u = part.trim().split(/\s+/)[0];
        if (/^\/[^?#]+\.(?:jpe?g|png|webp|avif|gif)$/i.test(u)) refs.add(u);
      }
    }
    for (const r of refs) {
      let rel = r;
      try {
        rel = decodeURIComponent(r);
      } catch {}
      if (fs.existsSync(path.join(p.site, rel))) continue;
      const key = variantBase(rel);
      if (!missingGroups.has(key)) missingGroups.set(key, new Set());
      missingGroups.get(key).add(rel);
    }
  }
  for (const [key, set] of missingGroups) {
    const files = [...set];
    const sized = files.map((f) => /-(\d+)x(\d+)\.[a-z0-9]+$/i.exec(f)).filter(Boolean).sort((a, b) => b[1] * b[2] - a[1] * a[2])[0];
    add("im-" + fnv(key), {
      kind: "image",
      group: "Photos",
      value: files[0],
      files,
      width: sized ? Number(sized[1]) : null,
      height: sized ? Number(sized[2]) : null,
      shown: true,
      missing: true,
      section: "",
    });
  }

  // Videos: the ones the pages name (attributes, data attributes, inline config), not every stream variant.
  const mediaRefs = scans.flatMap((s) => s.media);
  const videoSet = new Map();
  for (const m of mediaRefs) if (m.attr !== "poster") videoSet.set(m.value, m);
  for (const f of htmlFiles) {
    const html = fs.readFileSync(f, "utf8");
    for (const m of html.matchAll(/(?:https?:)?\/\/[^"'\s<>()]+?\.(?:m3u8|mp4|webm|mov)(?:\?[^"'\s<>()]*)?|\/[^"'\s<>()]+?\.(?:mp4|webm|mov)\b/gi)) {
      const v = m[0].replace(/&amp;/g, "&");
      if (!videoSet.has(v)) videoSet.set(v, { value: v, section: "" });
    }
  }
  for (const [src, m] of videoSet) {
    const streams = /^https?:/i.test(src) || /\.m3u8/i.test(src);
    add("v-" + fnv(src), { kind: "video", group: "Videos", value: src, streams, section: m.section || "" });
  }

  // Fonts and colours from the stylesheets.
  const faces = new Map();
  const colors = {};
  const channelVars = {};
  // Stylesheets, plus the <style> blocks inside pages (many sites declare their fonts there).
  const inlineStyles = htmlFiles.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]));
  for (const f of [...cssFiles, ...inlineStyles.map((css, i) => ({ inline: css, i }))]) {
    const css = typeof f === "string" ? fs.readFileSync(f, "utf8") : f.inline;
    const s = cssScan(css);
    Object.assign(channelVars, s.channels);
    for (const face of s.faces) {
      const k = face.family.toLowerCase();
      if (!faces.has(k)) faces.set(k, { family: face.family, weights: new Set(), files: new Set(), google: false });
      const e = faces.get(k);
      e.weights.add(face.weight + (face.style !== "normal" ? " " + face.style : ""));
      for (const src of face.srcs) {
        if (/fonts\.gstatic\.com/.test(src)) e.google = true;
        e.files.add(src);
      }
    }
    for (const [c, n] of Object.entries(s.colors)) colors[c] = (colors[c] || 0) + n;
  }
  for (const f of faces.values()) {
    const free = f.google || FREE_FONTS.test(f.family);
    add("ff-" + fnv(f.family.toLowerCase()), {
      kind: "font",
      group: "Fonts",
      value: f.family,
      weights: [...f.weights],
      files: [...f.files].slice(0, 20),
      license: free ? "free (open font license)" : "check: likely a paid license",
    });
  }
  Object.entries(colors)
    .filter(([c]) => !/rgba?\(0,0,0,0\)|transparent/.test(c))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([c, n]) => add("c-" + fnv(c), { kind: "color", group: "Colours", value: c, uses: n }));
  for (const [name, rgb] of Object.entries(channelVars).slice(0, 16)) {
    add("cv-" + fnv(name), { kind: "color", group: "Colours", value: `rgb(${rgb})`, variable: name, channels: rgb });
  }

  // What earlier swaps put in is yours: a re-listing must not count it as the original's again.
  const applied = prev.slots.filter((s) => s.status === "applied" && s.swap != null);
  const yoursText = new Set(applied.filter((s) => s.kind === "text" || s.kind === "attr" || s.kind === "link" || s.kind === "form").map((s) => norm(s.swap)));
  const yoursVars = new Set(applied.filter((s) => s.kind === "color" && s.variable).map((s) => s.variable));
  const isYours = (s) =>
    ((s.kind === "text" || s.kind === "attr" || s.kind === "link" || s.kind === "form") && yoursText.has(norm(s.value))) ||
    (s.kind === "video" && String(s.value).startsWith("/_remake/media/")) ||
    (s.kind === "color" && s.variable && yoursVars.has(s.variable));
  const list = [...bySlot.values()].map((s) => {
    const known = keep.get(s.id);
    const before = known?.status === "applied" ? known : isYours(s) ? { status: "applied", swap: s.value, appliedAt: "earlier swap" } : known;
    const flags = [];
    if (s.kind === "image" && s.missing) flags.push("missing in the copy");
    else if (s.kind === "image" && s.group === "Photos") flags.push("their photo");
    if (s.kind === "image" && s.group === "Logos") flags.push("their trademark");
    if (s.kind === "font" && !/free/.test(s.license)) flags.push("paid font");
    if (s.kind === "video" && s.streams) flags.push("plays from their account");
    if (s.kind === "form") flags.push("not wired");
    if (s.kind === "text" && s.value.length > 40) flags.push("their words");
    return { ...s, flags, swap: before?.swap ?? null, status: before?.status || "original", appliedAt: before?.appliedAt };
  });
  const order = ["Copy", "Headlines", "Buttons & menus", "Logos", "Photos", "Videos", "Fonts", "Colours", "Links & contact", "Image descriptions", "Search & sharing", "Icons"];
  list.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || (b.value?.length || 0) - (a.value?.length || 0));
  const content = {
    site: cfg.url,
    generatedAt: new Date().toISOString(),
    howToSwap:
      "Set a slot's `swap`, then run `remake apply`. Text and attributes: the new words. Images: a path to your file. Videos: a path to an MP4, or to a photo (it becomes a slow-zoom clip). " +
      "Fonts: a Google Fonts family name (e.g. \"Inter\"). Links: the new URL. Forms: the address that should receive submissions. " +
      "Colours: any CSS colour. Inline SVG logos: a path to your .svg. Leave `swap` null to keep the original.",
    summary: summarize(list),
    slots: list,
  };
  writeJson(p.content, content);
  printSummary(content);
  return content;
}

function groupForText(t) {
  if (/^h[1-3]$/.test(t.tag) || t.tag === "title") return "Headlines";
  if (["a", "button", "label", "option", "summary"].includes(t.tag) || t.value.length < 24) return "Buttons & menus";
  return "Copy";
}

export function summarize(list) {
  const groups = {};
  for (const s of list) {
    if (s.kind === "image" && !s.shown && s.group !== "Icons" && s.group !== "Logos") continue;
    const g = (groups[s.group] = groups[s.group] || { slots: 0, swapped: 0, words: 0 });
    g.slots++;
    if (s.status === "applied") g.swapped++;
    if (s.kind === "text") g.words += s.value.split(/\s+/).length;
  }
  const total = Object.values(groups).reduce((a, g) => a + g.slots, 0);
  const swapped = Object.values(groups).reduce((a, g) => a + g.swapped, 0);
  return { total, swapped, yours: total ? Math.round((100 * swapped) / total) : 0, groups };
}

function printSummary(content) {
  const s = content.summary;
  for (const [g, v] of Object.entries(s.groups)) say(`  ${g.padEnd(20)} ${String(v.slots).padStart(4)}${v.words ? ` (${v.words} words)` : ""}${v.swapped ? `, ${v.swapped} swapped` : ""}`);
  say(`\n  ${s.total} slots, ${s.yours}% yours. Swap file: remake/content.json`);
}

// ---------- apply ----------

function replaceRanges(text, ranges) {
  ranges.sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of ranges) out = out.slice(0, r.start) + r.with + out.slice(r.end);
  return out;
}

async function googleFont(polite, family, weights, p) {
  const ws = [...new Set(weights.map((w) => parseInt(w, 10)).filter((n) => n >= 100 && n <= 900))].sort();
  const axis = ws.length ? `:wght@${ws.join(";")}` : "";
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}${axis}&display=swap`;
  const res = await fetch(cssUrl, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36" } });
  if (!res.ok) throw new RemakeError(`Google Fonts has no family called "${family}".`, "Use the exact name from fonts.google.com.");
  let css = await res.text();
  const dir = path.join(p.site, "_remake", "fonts", family.replace(/\s+/g, "-").toLowerCase());
  for (const m of [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)]) {
    const r = await polite.get(m[1], { type: "font" });
    if (!r) continue;
    const name = path.basename(new URL(m[1]).pathname);
    writeFile(path.join(dir, name), r.buffer);
    css = css.split(m[1]).join(`/_remake/fonts/${path.basename(dir)}/${name}`);
  }
  return css;
}

export async function apply(project, opts = {}) {
  const { p, cfg } = project;
  const content = readJson(p.content);
  if (!content) throw new RemakeError("No swap file yet.", "Run `remake slots` first.");
  const todo = content.slots.filter((s) => s.swap != null && s.swap !== "" && (s.status !== "applied" || opts.force));
  if (!todo.length) {
    say("Nothing to apply: no slot has a `swap` value that isn't applied yet.");
    return content;
  }
  step(`Applying ${todo.length} swaps`);
  // Keep the last score of the untouched remake: after swaps, it no longer looks like the original, on purpose.
  const baseline = path.join(p.work, "score-before-swaps.json");
  if (!fs.existsSync(baseline) && fs.existsSync(p.score)) fs.copyFileSync(p.score, baseline);
  const fileCache = new Map();
  const read = (rel) => {
    const abs = path.join(project.root, rel);
    if (!fileCache.has(abs)) fileCache.set(abs, fs.readFileSync(abs, "utf8"));
    return { abs, text: fileCache.get(abs) };
  };
  const writeBack = (abs, text) => fileCache.set(abs, text);
  const htmlFiles = walk(p.site, (f) => f.endsWith(".html") && !f.includes(`${path.sep}_remake${path.sep}`)).map((f) => path.relative(project.root, f));
  const cssFiles = walk(p.site, (f) => f.endsWith(".css")).map((f) => path.relative(project.root, f));
  let browser = null;
  let imgPage = null;
  const store = new HttpStore(p.cache);
  const polite = new Polite(store, { interval: 0.3, archive: false });
  const fontCss = [];
  const streamed = [];

  for (const s of todo) {
    try {
      if (s.kind === "text" || s.kind === "attr") {
        const next = String(s.swap);
        if (s.kind === "text" && s.value.length > 12) {
          const ratio = next.length / s.value.length;
          if (ratio > 1.25 || ratio < 0.6) warn(`"${s.value.slice(0, 40)}…" → ${next.length} characters vs ${s.value.length}: may change the layout`);
        }
        for (const loc of s.where) {
          const { abs, text } = read(loc.file);
          if (loc.mode === "literal") {
            writeBack(abs, text.split(loc.needle).join(JSON.stringify(next)));
            continue;
          }
          const found = scanHtml(text, loc.file);
          const ranges = s.kind === "text"
            ? found.text.filter((t) => t.value === s.value).flatMap((t) => {
                const inner = text.slice(t.start, t.end);
                // Plain text inside: replace it. Markup inside: put the words in the first text node,
                // empty the others, and leave every element where it is.
                if (!/</.test(inner) || !t.nodes?.length) return [{ start: t.start, end: t.end, with: keepEdges(inner, escapeText(next)) }];
                return t.nodes.map((nd, i) => ({ start: nd.start, end: nd.end, with: i === 0 ? keepEdges(text.slice(nd.start, nd.end), escapeText(next)) : "" }));
              })
            : found.attrs.filter((a) => a.name === s.attr && a.value === s.value).map((a) => ({ start: a.start, end: a.end, with: escapeAttr(next) }));
          writeBack(abs, replaceRanges(text, ranges));
        }
      } else if (s.kind === "link" || s.kind === "form") {
        const next = String(s.swap);
        for (const rel of htmlFiles) {
          const { abs, text } = read(rel);
          const found = scanHtml(text, rel);
          const items = s.kind === "link" ? found.links.filter((l) => l.href === s.value) : found.forms.filter((f) => (f.action || "(no address)") === s.value && f.start != null);
          let out = replaceRanges(text, items.map((l) => ({ start: l.start, end: l.end, with: escapeAttr(next) })));
          if (s.kind === "form") out = out.replace(new RegExp(`(<form\\b[^>]*action=["']${next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'])`, "g"), "$1 data-remake-live");
          writeBack(abs, out);
        }
      } else if (s.kind === "color" && s.variable) {
        const rgb = toChannels(String(s.swap));
        if (!rgb) throw new RemakeError(`"${s.swap}" isn't a colour I can read. Use #rrggbb or rgb(r g b).`);
        const re = new RegExp(`(${s.variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*)${s.channels.replace(/ /g, "\\s+")}`, "g");
        for (const rel of [...cssFiles, ...htmlFiles]) {
          const { abs, text } = read(rel);
          writeBack(abs, text.replace(re, `$1${rgb}`));
        }
      } else if (s.kind === "color") {
        const next = String(s.swap);
        const re = new RegExp(s.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/,/g, ",\\s*"), "gi");
        const short = /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i.exec(s.value);
        for (const rel of [...cssFiles, ...htmlFiles]) {
          const { abs, text } = read(rel);
          let out = text.replace(re, next);
          if (short) out = out.replace(new RegExp(`#${short[1]}${short[2]}${short[3]}\\b`, "gi"), next);
          writeBack(abs, out);
        }
      } else if (s.kind === "image") {
        const src = path.resolve(String(s.swap));
        if (!fs.existsSync(src)) throw new RemakeError(`File not found: ${src}`);
        if (!browser) {
          browser = await launch();
          const ctx = await browser.newContext();
          imgPage = await ctx.newPage();
        }
        for (const f of s.files) {
          const target = path.join(p.site, f);
          const ext = path.extname(f).toLowerCase();
          const named = /-(\d+)x(\d+)\.[a-z0-9]+$/i.exec(f);
          const dims = (fs.existsSync(target) && imageSize(fs.readFileSync(target), f)) ||
            (named ? { width: Number(named[1]), height: Number(named[2]) } : { width: s.width || 1200, height: s.height || 800 });
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (ext === ".svg") {
            fs.writeFileSync(target, src.endsWith(".svg") ? fs.readFileSync(src) : wrapAsSvg(src, dims.width, dims.height));
          } else {
            fs.writeFileSync(target, await renderInto(imgPage, src, dims.width, dims.height, ext, 0.9, s.group === "Logos" || s.group === "Icons" ? "contain" : "cover"));
          }
        }
      } else if (s.kind === "video") {
        const src = path.resolve(String(s.swap));
        if (!fs.existsSync(src)) throw new RemakeError(`File not found: ${src}`);
        fs.mkdirSync(path.join(p.site, "_remake", "media"), { recursive: true });
        let dest;
        if (/\.(png|jpe?g|webp)$/i.test(src)) {
          // A photo for a video slot: make a slow-zoom clip of it, upright when the slot is a phone video.
          if (!browser) {
            browser = await launch();
            imgPage = await (await browser.newContext()).newPage();
          }
          const tall = htmlFiles.some((rel) => read(rel).text.includes(`data-mobile_src="${s.value}"`)) || /mobile|portrait|vertical/i.test(s.section || "");
          dest = `/_remake/media/clip-${fnv(s.id + src)}.mp4`;
          fs.writeFileSync(path.join(p.site, dest), await clipFromImage(imgPage, src, tall ? 720 : 1280, tall ? 1280 : 720, { drift: tall ? -1 : 1 }));
        } else {
          dest = `/_remake/media/${path.basename(src).replace(/[^a-z0-9._-]+/gi, "-")}`;
          fs.copyFileSync(src, path.join(p.site, dest));
        }
        for (const rel of htmlFiles) {
          const { abs, text } = read(rel);
          writeBack(abs, text.split(s.value).join(dest));
        }
        if (s.streams) streamed.push(dest);
      } else if (s.kind === "font") {
        const css = await googleFont(polite, String(s.swap), s.weights || ["400"], p);
        // Keep the family name the site asks for; serve your font under it.
        fontCss.push(css.replace(/font-family:\s*'[^']+'/g, `font-family: '${s.value}'`));
        // And stop shipping the original font: its rules, its preloads and its files.
        const fam = s.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const faceRe = new RegExp(`@font-face\\s*{[^}]*font-family\\s*:\\s*["']?${fam}["']?\\s*;[^}]*}`, "gi");
        for (const rel of [...cssFiles, ...htmlFiles]) {
          const { abs, text } = read(rel);
          let out = text.replace(faceRe, "");
          for (const src of s.files || []) {
            const file = src.split(/[?#]/)[0];
            out = out.replace(new RegExp(`<link\\b[^>]*href=["'][^"']*${file.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "gi"), "");
          }
          writeBack(abs, out);
        }
        for (const src of s.files || []) {
          const local = path.join(p.site, src.split(/[?#]/)[0].replace(/^https?:\/\/[^/]+/, ""));
          if (local.startsWith(p.site) && fs.existsSync(local)) fs.rmSync(local);
        }
      } else if (s.kind === "svg") {
        const src = path.resolve(String(s.swap));
        const svg = fs.readFileSync(src, "utf8").replace(/<\?xml[^>]*>/, "").trim();
        for (const loc of s.where) {
          const { abs, text } = read(loc.file);
          const found = scanHtml(text, loc.file).svgs.filter((x) => "s-" + fnv(text.slice(x.start, x.end)) === s.id);
          writeBack(abs, replaceRanges(text, found.map((x) => ({ start: x.start, end: x.end, with: svg }))));
        }
      }
      s.status = "applied";
      s.appliedAt = new Date().toISOString();
      ok(`${s.group}: ${String(s.value).slice(0, 60)}`);
    } catch (e) {
      warn(`${s.group}: ${String(s.value).slice(0, 50)}: ${e.message}`);
    }
  }
  if (fontCss.length) {
    const file = path.join(p.site, "_remake", "fonts.css");
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    writeFile(file, prev + "\n" + fontCss.join("\n"));
    for (const rel of htmlFiles) {
      const { abs, text } = read(rel);
      if (!text.includes("/_remake/fonts.css")) writeBack(abs, text.replace(/<\/head>/i, '<link rel="stylesheet" href="/_remake/fonts.css"></head>'));
    }
  }
  // Next.js pages also carry their words in the page data; swap them there too, or the original
  // words come back as soon as React takes over the page.
  const pairs = new Map();
  for (const s of todo) {
    if (s.status !== "applied" || s.swap == null) continue;
    if (s.kind === "text" || s.kind === "attr") pairs.set(norm(s.value), String(s.swap));
    if (s.kind === "link") pairs.set(s.value, String(s.swap));
  }
  for (const rel of htmlFiles) {
    const { abs, text } = read(rel);
    if (pairs.size && hasFlight(text)) writeBack(abs, withFlight(text, (row, isText) => replaceInRow(row, isText, pairs)));
  }
  for (const [abs, text] of fileCache) fs.writeFileSync(abs, text);
  if (browser) await browser.close();
  if (streamed.length) warn(`${streamed.length} videos were streams: your files replace their addresses in the HTML. If one still shows the old video, its player is set up in a script; point it at its file in /_remake/media/.`);
  store.save();
  content.summary = summarize(content.slots);
  writeJson(p.content, content);
  say(`\n  ${content.summary.yours}% of the site is yours now. Run \`remake board\` to refresh the swap board.`);
  return content;
}

function toChannels(color) {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(" ");
  }
  const rgb = /rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(color);
  return rgb ? `${rgb[1]} ${rgb[2]} ${rgb[3]}` : null;
}

function keepEdges(raw, inner) {
  const lead = /^\s*/.exec(raw)[0];
  const trail = /\s*$/.exec(raw)[0];
  return lead + inner + trail;
}
