// The two pages every remake ships with, behind the same passcode as the site:
//   /_remake/       proof: original vs remake, drag to compare, with the score of every screen
//   /_remake/swap/  swap board: everything that still belongs to the original, and what Claude needs from you
// plus MAKE-IT-YOURS.md, the same checklist as text.
import fs from "node:fs";
import path from "node:path";
import { launch } from "./browser.mjs";
import { pageId } from "./score.mjs";
import { summarize } from "./slots.mjs";
import { RemakeError, say, ok, step, readJson, writeFile, ensureDir } from "./util.mjs";

const NEEDS = {
  Headlines: "Your headline for each one, about the same length.",
  Copy: "Your About page, a LinkedIn bio or a few notes. Claude rewrites each block in your voice, at the same length so the layout holds.",
  "Buttons & menus": "Usually nothing: these follow once the copy is done. Say so if your menu needs different pages.",
  Logos: "Your logo as an SVG, or a PNG on a transparent background.",
  Photos: "Your photos if you have them. If not, nothing: Remake makes new pictures in the same frame and mood (Codex on your ChatGPT plan, or free stock).",
  Videos: "Your clips (MP4), or photos: each photo becomes a slow-zoom clip.",
  Fonts: "Nothing: Claude picks a free look-alike from Google Fonts, unless you have a font of your own.",
  Colours: "Keep them, or give your two or three brand colours.",
  "Links & contact": "Your email, booking link and social profiles, and where form messages should go.",
  "Search & sharing": "Your site name and a one-line description.",
  "Image descriptions": "Nothing: Claude rewrites these to describe your photos.",
  Icons: "Usually nothing. Your logo replaces the favicon.",
};

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
:root{--bg:#f4f5f7;--panel:#fff;--ink:#15171b;--muted:#5b626d;--line:#dde0e5;--accent:#ff5a1f;--soft:#fff0e8;--good:#1d8248;--bad:#c4321b;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);padding:32px max(16px,env(safe-area-inset-left)) 64px}
.wrap{max-width:1180px;margin:0 auto;display:grid;gap:36px}
h1{font:800 clamp(30px,5vw,52px)/1 var(--sans);letter-spacing:-.035em;margin:6px 0 10px}h2{font:800 24px/1.1 var(--sans);letter-spacing:-.02em;margin:0}
h3{font:700 16px/1.25 var(--sans);letter-spacing:-.01em;margin:0}p{margin:0;max-width:72ch}.muted{color:var(--muted)}
.eyebrow{font:500 12px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
a{color:inherit;text-underline-offset:3px}.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;letter-spacing:-.01em;padding:10px 14px;border-radius:8px}
.btn.ghost{background:var(--panel);color:var(--ink);border:1px solid var(--line)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;display:grid;gap:4px}
.tile b{font:800 28px/1 var(--sans);letter-spacing:-.03em;font-variant-numeric:tabular-nums}.tile span{color:var(--muted);font-size:13px}
.pass{color:var(--good)}.fail{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr));gap:18px}
.grid.phone{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
figure{margin:0;display:grid;gap:8px;min-width:0}figcaption{display:flex;justify-content:space-between;gap:8px;font:500 12px/1.4 var(--mono);color:var(--muted)}
figcaption b{color:var(--ink)}
.cmp{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#000;cursor:ew-resize;touch-action:pan-y;user-select:none}
.cmp img{display:block;width:100%;height:auto;pointer-events:none}.cmp .top{position:absolute;inset:0;clip-path:inset(0 0 0 var(--x,50%))}
.cmp .bar{position:absolute;top:0;bottom:0;left:var(--x,50%);width:2px;margin-left:-1px;background:var(--accent)}
.cmp .lab{position:absolute;bottom:6px;font:600 10px/1 var(--mono);text-transform:uppercase;background:rgba(0,0,0,.65);color:#fff;padding:4px 6px;border-radius:4px}
.cmp .l{left:6px}.cmp .r{right:6px}.cmp input{position:absolute;inset:0;width:100%;height:100%;opacity:0;margin:0;cursor:ew-resize}
section{display:grid;gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;display:grid;gap:12px;min-width:0}
.need{background:var(--soft);border-radius:8px;padding:10px 12px;font-size:14px}
.need b{color:var(--accent)}
.list{display:grid;gap:6px;max-height:520px;overflow:auto}
.item{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);min-width:0}
.item .v{overflow-wrap:anywhere}.item .s{font:500 11px/1.4 var(--mono);color:var(--muted)}
.chip{font:600 11px/1 var(--sans);padding:5px 8px;border-radius:999px;white-space:nowrap;background:#eef0f3;color:var(--muted)}
.chip.done{background:#e3f4ea;color:var(--good)}.chip.flag{background:var(--soft);color:var(--accent)}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.thumb{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fafafa;display:grid;min-width:0}
.thumb img{width:100%;height:120px;object-fit:contain;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}
.thumb div{padding:6px 8px;font:500 11px/1.35 var(--mono);color:var(--muted);display:flex;justify-content:space-between;gap:6px}
.sw{display:flex;gap:10px;flex-wrap:wrap}.sw div{display:grid;gap:4px;font:500 11px/1 var(--mono);color:var(--muted)}
.sw i{display:block;width:64px;height:44px;border-radius:8px;border:1px solid var(--line)}
.progress{height:10px;background:#e6e8ec;border-radius:99px;overflow:hidden}.progress i{display:block;height:100%;background:var(--accent)}
@media (max-width:600px){.item{grid-template-columns:1fr}}
`;

const SLIDER_JS = `document.querySelectorAll('.cmp input').forEach(function(i){i.addEventListener('input',function(){i.parentElement.style.setProperty('--x',i.value+'%')})});`;

function shell(title, body, script = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">${body}</div>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

async function toJpeg(page, pngFile, maxWidth) {
  const data = fs.readFileSync(pngFile).toString("base64");
  const b64 = await page.evaluate(
    async ({ data, maxWidth }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + data;
      await img.decode();
      const s = Math.min(1, maxWidth / img.naturalWidth);
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.82).split(",")[1];
    },
    { data, maxWidth },
  );
  return Buffer.from(b64, "base64");
}

export async function board(project) {
  const { cfg, p } = project;
  const score = readJson(p.score);
  const content = readJson(p.content);
  if (!score) throw new RemakeError("No score yet.", "Run `remake score` first.");
  if (!content) throw new RemakeError("No swap file yet.", "Run `remake slots` first.");
  step("Building the proof page and the swap board");
  const proofDir = ensureDir(path.join(p.remakeSite, "proof"));
  const browser = await launch();
  const page = await (await browser.newContext()).newPage();
  const sections = [];
  try {
    for (const [id, pg] of Object.entries(score.pages)) {
      for (const vpName of Object.keys(cfg.viewports)) {
        const v = pg[vpName];
        if (!v) continue;
        const figs = [];
        for (const s of v.screens) {
          const n = String(s.i).padStart(2, "0");
          const o = path.join(p.original, id, vpName, `${n}.png`);
          const r = path.join(p.scoreDir, `${id}-${vpName}-${n}.remake.png`);
          if (!fs.existsSync(o) || !fs.existsSync(r)) continue;
          const max = vpName === "desktop" ? 1200 : 390;
          fs.writeFileSync(path.join(proofDir, `${id}-${vpName}-${n}-o.jpg`), await toJpeg(page, o, max));
          fs.writeFileSync(path.join(proofDir, `${id}-${vpName}-${n}-r.jpg`), await toJpeg(page, r, max));
          const cls = s.score >= cfg.thresholds.screen ? "pass" : "fail";
          figs.push(`<figure><figcaption><b>Screen ${s.i + 1}</b><span class="${cls}">${s.score.toFixed(2)}% match</span></figcaption>
<div class="cmp" style="--x:50%"><img alt="Original, screen ${s.i + 1}" src="proof/${id}-${vpName}-${n}-o.jpg"><div class="top"><img alt="Remake, screen ${s.i + 1}" src="proof/${id}-${vpName}-${n}-r.jpg"></div><div class="bar"></div><span class="lab l">Original</span><span class="lab r">Remake</span><input id="cmp-${id}-${vpName}-${n}" type="range" min="0" max="100" value="50" aria-label="Compare original and remake, screen ${s.i + 1}"></div></figure>`);
        }
        sections.push(`<section><div class="row" style="justify-content:space-between"><h2>${esc(pg.path)} · ${vpName}</h2><span class="eyebrow">lowest ${v.lowest.toFixed(2)}% · height ${v.height.original} → ${v.height.remake}px</span></div><div class="grid ${vpName === "phone" ? "phone" : ""}">${figs.join("")}</div></section>`);
      }
    }
  } finally {
    await browser.close();
  }
  const lowest = (vp) => Math.min(...Object.values(score.pages).filter((x) => x[vp]).map((x) => x[vp].lowest));
  const tile = (label, val, pass) => `<div class="tile"><b class="${pass ? "pass" : "fail"}">${val}</b><span>${label}</span></div>`;
  const t = cfg.thresholds;
  const tiles = [
    tile("lowest screen, desktop", `${lowest("desktop").toFixed(1)}%`, lowest("desktop") >= t.screen),
    tile("lowest screen, phone", `${lowest("phone").toFixed(1)}%`, lowest("phone") >= t.screen),
    score.motion ? tile(`lowest of ${score.motion.frames.length} motion frames`, `${score.motion.lowest.toFixed(1)}%`, score.motion.lowest >= t.motion) : "",
    tile("of the site is yours", `${content.summary.yours}%`, content.summary.yours === 100),
  ].join("");
  const proof = shell(
    `Remake of ${cfg.host}`,
    `<header><div class="eyebrow">Remake · proof · scored ${new Date(score.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div>
<h1>Remake of ${esc(cfg.host)}</h1>
<p class="muted">Each picture is the original and the remake frozen at the same instant: same clock, same random numbers, videos on their first frame. Drag to compare. Pass mark: ${t.screen}% of stable pixels on every screen, ${t.motion}% on every motion frame.</p>
<div class="row" style="margin-top:16px"><a class="btn" href="/">Open the remake</a><a class="btn ghost" href="/_remake/swap/">Swap board</a><a class="btn ghost" href="${esc(cfg.url)}" target="_blank" rel="noopener">Original site</a></div></header>
<div class="tiles">${tiles}</div>${sections.join("")}`,
    SLIDER_JS,
  );
  writeFile(path.join(p.remakeSite, "index.html"), proof);

  // Swap board
  const summary = summarize(content.slots);
  const groups = {};
  for (const s of content.slots) {
    if (s.kind === "image" && !s.shown && s.group === "Photos") continue;
    (groups[s.group] = groups[s.group] || []).push(s);
  }
  const chip = (s) => (s.status === "applied" ? `<span class="chip done">yours</span>` : s.flags?.length ? `<span class="chip flag">${esc(s.flags[0])}</span>` : `<span class="chip">original</span>`);
  const blocks = Object.entries(groups).map(([g, list]) => {
    let inner = "";
    if (list[0].kind === "image") {
      inner = `<div class="thumbs">${list.slice(0, 240).map((s) => `<div class="thumb"><img loading="lazy" alt="${esc(s.alt || s.value)}" src="${esc(s.value)}"><div><span>${s.width ? `${s.width}×${s.height}` : ""}</span>${chip(s)}</div></div>`).join("")}</div>`;
    } else if (list[0].kind === "color") {
      inner = `<div class="sw">${list.map((s) => `<div><i style="background:${esc(s.value)}"></i>${esc(s.value)}${s.status === "applied" ? " ✓" : ""}</div>`).join("")}</div>`;
    } else {
      inner = `<div class="list">${list.slice(0, 400).map((s) => `<div class="item"><div class="v">${esc(String(s.value).slice(0, 280))}${s.kind === "font" ? ` <span class="s">${esc((s.weights || []).join(", "))} · ${esc(s.license)}</span>` : ""}${s.label ? ` <span class="s">“${esc(s.label)}”</span>` : ""}<div class="s">${esc(s.section || s.category || "")}</div></div>${chip(s)}</div>`).join("")}</div>`;
    }
    const g2 = summary.groups[g] || { slots: list.length, swapped: 0 };
    return `<section class="card"><div class="row" style="justify-content:space-between"><h2>${esc(g)}</h2><span class="eyebrow">${g2.swapped}/${g2.slots} yours${g2.words ? ` · ${g2.words} words` : ""}</span></div>${NEEDS[g] ? `<div class="need"><b>What Claude needs from you:</b> ${esc(NEEDS[g])}</div>` : ""}${inner}</section>`;
  });
  const swap = shell(
    `Make ${cfg.host} yours`,
    `<header><div class="eyebrow">Remake · swap board</div><h1>Make it yours</h1>
<p class="muted">Everything below still belongs to ${esc(cfg.host)}. Send Claude what each section asks for; it fills remake/content.json and runs <code>remake apply</code>. Keep the passcode on until this reaches 100%.</p>
<div style="display:grid;gap:8px;margin-top:16px;max-width:520px"><div class="row" style="justify-content:space-between"><b>${summary.yours}% yours</b><span class="muted">${summary.swapped} of ${summary.total} slots</span></div><div class="progress"><i style="width:${summary.yours}%"></i></div></div>
<div class="row" style="margin-top:16px"><a class="btn" href="/">Open the remake</a><a class="btn ghost" href="/_remake/">Proof</a></div></header>${blocks.join("")}`,
  );
  writeFile(path.join(p.remakeSite, "swap", "index.html"), swap);

  // Same checklist as text, for the repo and for Claude.
  const lines = [
    `# Make it yours: ${cfg.host}`,
    "",
    `Remake of ${cfg.url}. ${summary.yours}% yours (${summary.swapped} of ${summary.total} slots swapped).`,
    "Until this reaches 100%, the site is a copy of someone else's work: keep the passcode on and don't publish it.",
    "",
    "| Group | Slots | Swapped | What Claude needs from you |",
    "| --- | ---: | ---: | --- |",
    ...Object.entries(summary.groups).map(([g, v]) => `| ${g} | ${v.slots}${v.words ? ` (${v.words} words)` : ""} | ${v.swapped} | ${NEEDS[g] || ""} |`),
    "",
    "## Watch out",
    "",
  ];
  const flagged = {};
  for (const s of content.slots) for (const f of s.flags || []) if (s.status !== "applied") flagged[f] = (flagged[f] || 0) + 1;
  const flagText = {
    "their photo": "photos are copyrighted by the original owner",
    "their trademark": "logos are trademarks of the original owner",
    "paid font": "fonts the original pays a licence for; swap or buy a licence",
    "plays from their account": "videos still stream from the original's video host",
    "not wired": "forms don't send anywhere yet",
    "their words": "long copy blocks are the original's writing",
  };
  for (const [f, n] of Object.entries(flagged)) lines.push(`- ${n} × ${flagText[f] || f}`);
  lines.push("", "## How to swap", "", content.howToSwap, "", "The board with thumbnails: `/_remake/swap/` on the deployed site.");
  const fonts = content.slots.filter((s) => s.kind === "font");
  if (fonts.length) lines.push("", "## Fonts", "", ...fonts.map((f) => `- **${f.value}** (${(f.weights || []).join(", ")}): ${f.license}`));
  const heads = content.slots.filter((s) => s.group === "Headlines").slice(0, 15);
  if (heads.length) lines.push("", "## Headlines", "", ...heads.map((h) => `- [${h.status === "applied" ? "x" : " "}] ${h.value}`));
  writeFile(p.roadmap, lines.join("\n") + "\n");
  ok("site/_remake/index.html (proof), site/_remake/swap/index.html (swap board), MAKE-IT-YOURS.md");
  say("\nNext: remake ship");
}
