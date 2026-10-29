// Next.js App Router pages carry their React data inside the HTML as a "flight" stream:
// <script>self.__next_f.push([1,"..."])</script>, several chunks, read in order. Some rows announce
// their own length in bytes (`id:T<hex>,<text>`), so any edit inside the stream must recompute those
// lengths, or React can't rebuild the page ("This page couldn't load"). This module decodes the
// stream, lets the caller edit it row by row, and writes it back as one valid chunk.

const PUSH = /<script\b[^>]*>\s*self\.__next_f\.push\(([\s\S]*?)\)\s*<\/script>/g;
export const MARK = "<!--remake:flight-->";

export const hasFlight = (html) => html.includes("self.__next_f.push(");

// Pull the data chunks out of the page. Returns the page with one marker where the data goes back.
export function extractFlight(html) {
  const chunks = [];
  let placed = false;
  const page = html.replace(PUSH, (tag, arg) => {
    let value;
    try {
      value = JSON.parse(arg);
    } catch {
      return tag;
    }
    if (!Array.isArray(value) || value[0] !== 1 || typeof value[1] !== "string") return tag;
    chunks.push(value[1]);
    if (placed) return "";
    placed = true;
    return MARK;
  });
  return chunks.length ? { page, stream: chunks.join("") } : null;
}

function parseRows(stream) {
  const buf = Buffer.from(stream, "utf8");
  const rows = [];
  let i = 0;
  while (i < buf.length) {
    const colon = buf.indexOf(0x3a, i);
    if (colon < 0) throw new Error("flight: row without a colon");
    const id = buf.toString("utf8", i, colon);
    if (buf[colon + 1] === 0x54 /* T */) {
      const comma = buf.indexOf(0x2c, colon + 2);
      const len = parseInt(buf.toString("utf8", colon + 2, comma), 16);
      if (comma < 0 || Number.isNaN(len)) throw new Error("flight: bad text row");
      rows.push({ id, t: true, text: buf.toString("utf8", comma + 1, comma + 1 + len) });
      i = comma + 1 + len;
    } else {
      const nl = buf.indexOf(0x0a, colon + 1);
      const end = nl < 0 ? buf.length : nl;
      rows.push({ id, t: false, text: buf.toString("utf8", colon + 1, end) });
      i = end + 1;
    }
  }
  return rows;
}

function writeRows(rows) {
  return rows.map((r) => (r.t ? `${r.id}:T${Buffer.byteLength(r.text, "utf8").toString(16)},${r.text}` : `${r.id}:${r.text}\n`)).join("");
}

// edit(text, isTextRow) returns the new row content. JSON rows hold JSON; text rows hold raw text.
export function editStream(stream, edit) {
  const rows = parseRows(stream);
  for (const r of rows) r.text = edit(r.text, r.t);
  return writeRows(rows);
}

export function flightScript(stream) {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const lit = JSON.stringify(stream).replace(/</g, "\\u003c").split(LS).join("\\u2028").split(PS).join("\\u2029");
  return `<script>self.__next_f.push([1,${lit}])</script>`;
}

// One call for the common case: edit the flight data of a page, leave the rest to `restOfPage`.
export function withFlight(html, editRows, restOfPage = (x) => x) {
  if (!hasFlight(html)) return restOfPage(html);
  const got = extractFlight(html);
  if (!got) return restOfPage(html);
  let stream = got.stream;
  try {
    stream = editStream(stream, editRows);
  } catch {
    // Unknown format: keep the data exactly as it was rather than break it.
  }
  return restOfPage(got.page).replace(MARK, flightScript(stream));
}

// A JSON-string-safe version of a piece of text (for replacing inside JSON rows).
export const jsonEscaped = (s) => JSON.stringify(s).slice(1, -1);

const norm = (s) => String(s).replace(/\s+/g, " ").trim();

// Swap words inside React element trees: an element whose whole text equals a swapped block gets the
// new text as its only child (the same thing `remake apply` did to the HTML), so hydration agrees.
// `pairs` maps normalised original text → new text.
export function replaceInRow(rowText, isTextRow, pairs) {
  if (!pairs.size) return rowText;
  if (isTextRow) {
    let out = rowText;
    for (const [from, to] of pairs) if (out.includes(from)) out = out.split(from).join(to);
    return out;
  }
  const c = rowText[0];
  if (c !== "[" && c !== "{" && c !== '"') return rowText;
  let data;
  try {
    data = JSON.parse(rowText);
  } catch {
    return rowText;
  }
  let changed = false;
  const textOf = (n) => {
    if (typeof n === "string") return n.startsWith("$") ? "" : n;
    if (Array.isArray(n)) return n[0] === "$" ? textOf(n[3]?.children) : n.map(textOf).join("");
    return "";
  };
  const spread = (holder, key, to) => {
    let first = true;
    const visit = (h, k) => {
      const n = h[k];
      if (typeof n === "string") {
        if (n.startsWith("$") || !n.trim()) return;
        const edges = /^(\s*)[\s\S]*?(\s*)$/.exec(n);
        h[k] = first ? edges[1] + to + edges[2] : "";
        first = false;
      } else if (Array.isArray(n)) {
        if (n[0] === "$") {
          if (n[3] && typeof n[3] === "object" && n[3].children !== undefined) visit(n[3], "children");
        } else n.forEach((_, i) => visit(n, i));
      }
    };
    visit(holder, key);
  };
  const swapString = (s) => {
    const k = norm(s);
    if (k && pairs.has(k)) return pairs.get(k);
    // Word lists packed as text inside a prop (translation messages): swap inside them too.
    if (s.length > 20 && (s[0] === "{" || s[0] === "[")) {
      let inner;
      try {
        inner = JSON.parse(s);
      } catch {
        return null;
      }
      const out = replaceInRow(JSON.stringify(inner), false, pairs);
      return out === JSON.stringify(inner) ? null : out;
    }
    return null;
  };
  const walk = (node) => {
    if (Array.isArray(node)) {
      if (node[0] === "$" && node[3] && typeof node[3] === "object" && !Array.isArray(node[3])) {
        const props = node[3];
        for (const key of Object.keys(props)) {
          if (key !== "children" && typeof props[key] === "string") {
            const to = swapString(props[key]);
            if (to !== null) {
              props[key] = to;
              changed = true;
            }
          } else if (key !== "children" && props[key] && typeof props[key] === "object") walk(props[key]); // e.g. translation messages
        }
        if (props.children !== undefined) {
          const whole = norm(textOf(props.children));
          if (whole && pairs.has(whole)) {
            const kids = props.children;
            // Plain text: swap it whole. Text among other elements (an icon, a game, a picture): put the
            // new words in the first piece of text and empty the rest, as the page itself was swapped.
            if (typeof kids === "string" || (Array.isArray(kids) && kids[0] !== "$" && kids.every((x) => typeof x === "string"))) props.children = pairs.get(whole);
            else spread(props, "children", pairs.get(whole));
            changed = true;
          } else walk(props.children);
        }
        return;
      }
      node.forEach((x, i) => {
        if (typeof x === "string") {
          const to = swapString(x);
          if (to !== null) {
            node[i] = to;
            changed = true;
          }
        } else walk(x);
      });
    } else if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (typeof v === "string") {
          const to = swapString(v);
          if (to !== null) {
            node[key] = to;
            changed = true;
          }
        } else walk(v);
      }
    }
  };
  if (typeof data === "string") {
    const to = swapString(data);
    return to === null ? rowText : JSON.stringify(to);
  }
  walk(data);
  return changed ? JSON.stringify(data) : rowText;
}
