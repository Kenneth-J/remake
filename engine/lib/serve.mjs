// A plain static server for site/, with byte ranges for video. Every 404 is written to
// remake/missing.log so `remake fetch --missing` can collect what the visit never loaded.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { MIME } from "./util.mjs";

// Vercel keeps /_next/static/immutable/ for itself; a remake serves those files from here instead.
export const MOVED_IMMUTABLE = "remake-immutable";

export function resolveFile(siteDir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    rel = urlPath.split("?")[0];
  }
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const base = path.join(siteDir, safe);
  if (!base.startsWith(siteDir)) return null;
  const candidates = [base, path.join(base, "index.html"), base + ".html"];
  // ship moves Next.js's _next/static/immutable aside (Vercel won't deploy that folder): look there too.
  if (/^[/\\]?_next[/\\]static[/\\]immutable[/\\]/.test(safe)) candidates.push(path.join(siteDir, safe.replace(/immutable/, MOVED_IMMUTABLE)));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

export function startServer(siteDir, { port = 0, missingLog, quiet = true } = {}) {
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const file = resolveFile(siteDir, req.url || "/");
    if (!file) {
      if (missingLog && !seen.has(req.url)) {
        seen.add(req.url);
        fs.appendFileSync(missingLog, req.url + "\n");
      }
      if (!quiet) process.stdout.write(`404 ${req.url}\n`);
      const notFound = path.join(siteDir, "404.html");
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : "Not found");
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const size = fs.statSync(file).size;
    const headers = { "content-type": type, "cache-control": "no-store", "accept-ranges": "bytes", "access-control-allow-origin": "*" };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "content-length": size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address();
      resolve({ port: p, url: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
