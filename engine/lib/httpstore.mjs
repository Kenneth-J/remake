// Record once, replay forever. Every response the original site sends during a visit is kept here,
// and every later visit (the second phone pass, the scoring runs) is answered from this store
// before anything goes back to the site. One visit's worth of load on their server, no more.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ensureDir, readJson, writeJson, sha1, fnv, sleep, UA_SUFFIX } from "./util.mjs";
import { isTracker, trackerHost, looksLikeBotWall } from "./guard.mjs";

const DROP_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "set-cookie",
  "connection",
  "keep-alive",
  "strict-transport-security",
  "alt-svc",
  "report-to",
  "nel",
  "content-security-policy",
  "content-security-policy-report-only",
  "server-timing",
  "date",
  "age",
  "expires",
  "etag",
  "last-modified",
]);

export function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (!DROP_HEADERS.has(key) && !key.startsWith("cf-") && !key.startsWith("x-vercel")) out[key] = v;
  }
  out["cache-control"] = "no-store";
  return out;
}

export class HttpStore {
  constructor(dir) {
    this.dir = ensureDir(dir);
    this.bodies = ensureDir(path.join(dir, "bodies"));
    this.file = path.join(dir, "index.json");
    const saved = readJson(this.file, {});
    this.entries = saved.entries || {};
    this.media = new Set(saved.media || []);
    this.trackers = new Set(saved.trackers || []);
    this.blocked = new Set(saved.blocked || []);
  }
  key(method, url, post = "", range = "") {
    return sha1(`${method} ${url} ${post ? fnv(post) : ""} ${range}`);
  }
  get(key) {
    return this.entries[key];
  }
  find(url) {
    return Object.values(this.entries).find((e) => e.url === url && e.method === "GET" && !e.range);
  }
  body(meta) {
    return fs.readFileSync(path.join(this.bodies, meta.body));
  }
  put(meta, body) {
    const hash = sha1(body);
    const file = path.join(this.bodies, hash);
    if (!fs.existsSync(file)) fs.writeFileSync(file, body);
    const key = this.key(meta.method, meta.url, meta.post || "", meta.range || "");
    const entry = {
      ...meta,
      post: undefined,
      postHash: meta.post ? fnv(meta.post) : "",
      postBody: meta.post && meta.post.length < 4000 ? meta.post : undefined,
      body: hash,
      size: body.length,
      contentType: (meta.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase(),
      time: new Date().toISOString(),
    };
    this.entries[key] = entry;
    return entry;
  }
  save() {
    writeJson(this.file, {
      entries: this.entries,
      media: [...this.media],
      trackers: [...this.trackers],
      blocked: [...this.blocked],
    });
  }
  all() {
    return Object.values(this.entries);
  }
}

// Answer the browser from the store; fetch and keep anything new.
// With `archive` ({ ts, own(host) }), the site's own files come from the Internet Archive's untouched
// copy (id_ mode) while the page keeps its own address, so its scripts run as they did on the site.
export async function attachStore(context, store, { onDocument, archive } = {}) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (!/^https?:/i.test(url)) return route.fallback();
    if (isTracker(url)) {
      store.trackers.add(trackerHost(url));
      return route.abort("blockedbyclient");
    }
    const method = req.method();
    const type = req.resourceType();
    // Video and audio stream straight from the source, like any visitor's player would.
    if (type === "media") {
      store.media.add(url.split("#")[0]);
      return route.continue();
    }
    if (!["GET", "POST", "HEAD"].includes(method)) return route.continue();
    const post = method === "POST" ? req.postData() || "" : "";
    const range = req.headers()["range"] || "";
    const key = store.key(method, url, post, range);
    const hit = store.get(key);
    if (hit) {
      return route.fulfill({ status: hit.status, headers: hit.headers, body: store.body(hit) });
    }
    const fromArchive = archive && archive.own(new URL(url).host) && method === "GET";
    let resp;
    try {
      resp = fromArchive
        ? await route.fetch({ url: `https://web.archive.org/web/${archive.ts}id_/${url}`, timeout: 90000 })
        : await route.fetch({ timeout: 60000 });
    } catch {
      return route.abort("failed").catch(() => {});
    }
    let body;
    try {
      body = await resp.body();
    } catch {
      return route.abort("failed").catch(() => {});
    }
    const headers = cleanHeaders(resp.headers());
    let status = resp.status();
    if (fromArchive) {
      // The Archive sometimes kept the site's bot-check page instead of the file: treat that as missing.
      const html = (headers["content-type"] || "").includes("html");
      if (status >= 400 && status !== 404) {
        // The Archive is busy: answer this load with an error, but don't remember it.
        return route.fulfill({ status: 503, body: "" }).catch(() => {});
      }
      if (status === 404 || (html && type !== "document") || (html && looksLikeBotWall(status, body.toString("utf8")))) {
        store.put({ url, method, status: 404, headers: {}, type, post, range, source: "archive", from: "polite" }, Buffer.alloc(0));
        return route.fulfill({ status: 404, body: "" }).catch(() => {});
      }
      status = 200;
    }
    if (type === "document" && onDocument) {
      const verdict = onDocument({ url, status, html: body.toString("utf8") });
      if (verdict === "block") return route.fulfill({ status, headers, body });
    }
    store.put({ url, method, status, headers, type, post, range, source: fromArchive ? "archive" : "live", from: "visit" }, body);
    return route.fulfill({ status, headers, body }).catch(() => {});
  });
}

// For files the visit never asked for (other image sizes, unused font weights, source maps):
// one request at a time per host, a pause between each, and the Internet Archive if the site says no.
export class Polite {
  constructor(store, { interval = 1.2, archive = false, log = () => {} } = {}) {
    this.store = store;
    this.interval = interval * 1000;
    this.archive = archive;
    this.last = new Map();
    this.fails = new Map();
    this.log = log;
  }

  async wait(host) {
    const since = Date.now() - (this.last.get(host) || 0);
    if (since < this.interval) await sleep(this.interval - since);
    this.last.set(host, Date.now());
  }

  async raw(url, { expectHtml = false, maxBytes = 0 } = {}) {
    const host = new URL(url).host;
    await this.wait(host);
    const res = await fetch(url, {
      headers: { "user-agent": `Mozilla/5.0 ${UA_SUFFIX}`, accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(maxBytes ? 300000 : 60000),
    });
    const length = Number(res.headers.get("content-length") || 0);
    if (maxBytes && length > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, headers: {}, body: Buffer.alloc(0), wall: false, tooBig: true };
    }
    let body = Buffer.from(await res.arrayBuffer());
    if (body[0] === 0x1f && body[1] === 0x8b) {
      try {
        body = zlib.gunzipSync(body);
      } catch {}
    }
    const headers = cleanHeaders(Object.fromEntries(res.headers));
    const ct = (headers["content-type"] || "").toLowerCase();
    const html = ct.includes("html") ? body.toString("utf8") : "";
    const wall = (!expectHtml && ct.includes("html")) || looksLikeBotWall(res.status, html);
    return { status: res.status, headers, body, wall, retryAfter: Number(res.headers.get("retry-after") || 0) };
  }

  async get(url, opts = {}) {
    const cached = this.store.find(url);
    if (cached && cached.status < 400) return { ...cached, buffer: this.store.body(cached), cached: true };
    if (cached && (cached.status === 404 || cached.status === 410)) return null;
    const host = new URL(url).host;
    if (!this.store.blocked.has(host)) {
      try {
        let r = await this.raw(url, opts);
        if (r.status === 429 && r.retryAfter && r.retryAfter <= 60) {
          await sleep(r.retryAfter * 1000);
          r = await this.raw(url, opts);
        }
        if (r.tooBig) return null;
        if (r.status < 400 && !r.wall) {
          this.fails.set(host, 0);
          const entry = this.store.put(
            { url, method: "GET", status: r.status, headers: r.headers, type: opts.type || "other", source: "live", from: "polite" },
            r.body,
          );
          return { ...entry, buffer: r.body };
        }
        if (r.status === 404 || r.status === 410) {
          // Remember it's gone, so a second run doesn't ask again.
          this.store.put({ url, method: "GET", status: r.status, headers: {}, type: opts.type || "other", source: "live", from: "polite" }, Buffer.alloc(0));
          return null;
        }
        this.noteFail(host, `${r.status}${r.wall ? " bot check" : ""}`);
      } catch (e) {
        this.noteFail(host, e.name === "TimeoutError" ? "timeout" : e.message);
      }
    }
    return this.archive ? this.fromArchive(url, opts) : null;
  }

  noteFail(host, why) {
    const n = (this.fails.get(host) || 0) + 1;
    this.fails.set(host, n);
    if (n >= 2 && !this.store.blocked.has(host)) {
      this.store.blocked.add(host);
      this.log(`${host} stopped answering (${why}). No more requests to it${this.archive ? "; using the Internet Archive instead" : ". Ask the user before trying `remake capture --archive`"}.`);
    }
  }

  // Returns the file, null when the Archive has no copy, or { error } when it couldn't answer now.
  async fromArchive(url, { expectHtml = false, type = "other", ts = null } = {}) {
    if (ts) {
      // Ask for the copy nearest to the project's archive date; the Archive redirects to it.
      try {
        const snap = await this.raw(`https://web.archive.org/web/${ts}id_/${url}`, { expectHtml });
        if (snap.status < 400 && !snap.wall) {
          const entry = this.store.put(
            { url, method: "GET", status: 200, headers: snap.headers, type, source: "archive", archivedAt: ts, from: "polite" },
            snap.body,
          );
          return { ...entry, buffer: snap.body };
        }
        if (snap.status === 404 || snap.wall) return null;
        return { error: `archive answered ${snap.status}` };
      } catch (e) {
        return { error: e.message };
      }
    }
    try {
      const cdx =
        "https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,mimetype&filter=statuscode:200&limit=-6&url=" +
        encodeURIComponent(url);
      const r = await this.raw(cdx, { expectHtml: true });
      if (r.status >= 400) return null;
      const rows = JSON.parse(r.body.toString("utf8") || "[]").slice(1).reverse();
      for (const [ts, mime] of rows) {
        if (!expectHtml && /html/i.test(mime)) continue;
        const snap = await this.raw(`https://web.archive.org/web/${ts}id_/${url}`, { expectHtml });
        if (snap.status < 400 && !snap.wall) {
          const entry = this.store.put(
            { url, method: "GET", status: 200, headers: snap.headers, type, source: "archive", archivedAt: ts, from: "polite" },
            snap.body,
          );
          return { ...entry, buffer: snap.body };
        }
      }
    } catch {}
    return null;
  }
}
