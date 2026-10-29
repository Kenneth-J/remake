// Image sizes from file headers, and resizing through the headless browser (no native dependencies).
import fs from "node:fs";
import path from "node:path";

export function imageSize(buf, file = "") {
  try {
    if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.toString("ascii", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const kind = buf.toString("ascii", 12, 16);
      if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (/\.svg$/i.test(file) || buf.toString("utf8", 0, 200).includes("<svg")) {
      const head = buf.toString("utf8", 0, 3000);
      const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
      const w = /\swidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(head);
      const h = /\sheight\s*=\s*["']([\d.]+)(px)?["']/i.exec(head);
      if (w && h) return { width: Math.round(+w[1]), height: Math.round(+h[1]) };
      if (vb) return { width: Math.round(+vb[1]), height: Math.round(+vb[2]) };
    }
  } catch {}
  return null;
}

const MIME_OUT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/webp", ".gif": "image/png", ".ico": "image/png" };

// Draw `srcFile` into width×height (cover crop) and encode it like the file it replaces.
export async function renderInto(page, srcFile, width, height, targetExt, quality = 0.9, fit = "cover") {
  const ext = path.extname(srcFile).toLowerCase();
  const mime = ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
  const dataUrl = `data:${mime};base64,${fs.readFileSync(srcFile).toString("base64")}`;
  const out = MIME_OUT[targetExt] || "image/png";
  const b64 = await page.evaluate(
    async ({ dataUrl, width, height, out, quality, fit }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d");
      // cover fills the frame (photos); contain fits inside it on a clear background (logos).
      const s = (fit === "contain" ? Math.min : Math.max)(width / (img.naturalWidth || width), height / (img.naturalHeight || height));
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
      return c.toDataURL(out, quality).split(",")[1];
    },
    { dataUrl, width, height, out, quality, fit },
  );
  return Buffer.from(b64, "base64");
}

// A photo swapped into a video slot: a 6-second slow zoom, encoded as MP4 by the browser itself.
export async function clipFromImage(page, srcFile, width, height, { seconds = 6, drift = 1 } = {}) {
  const ext = path.extname(srcFile).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const dataUrl = `data:${mime};base64,${fs.readFileSync(srcFile).toString("base64")}`;
  const b64 = await page.evaluate(
    async ({ dataUrl, W, H, dur, dir }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d");
      const type = MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.42E01E") ? "video/mp4;codecs=avc1.42E01E" : "video/webm;codecs=vp9";
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: type, videoBitsPerSecond: 4_000_000 });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start();
      const t0 = performance.now();
      await new Promise((done) => {
        const draw = () => {
          const t = Math.min(1, (performance.now() - t0) / dur);
          const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * (1.06 + 0.1 * t);
          const dw = img.naturalWidth * s;
          const dh = img.naturalHeight * s;
          ctx.drawImage(img, (W - dw) / 2 + dir * 30 * (t - 0.5), (H - dh) / 2, dw, dh);
          if (t < 1) requestAnimationFrame(draw);
          else done();
        };
        draw();
      });
      rec.stop();
      await new Promise((r) => (rec.onstop = r));
      const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let s = "";
      for (let k = 0; k < buf.length; k += 32768) s += String.fromCharCode(...buf.subarray(k, k + 32768));
      return btoa(s);
    },
    { dataUrl, W: width, H: height, dur: seconds * 1000, dir: drift },
  );
  return Buffer.from(b64, "base64");
}

// A raster swapped into an .svg slot: wrap it so the file stays a valid SVG of the same size.
export function wrapAsSvg(srcFile, width, height) {
  const ext = path.extname(srcFile).toLowerCase().slice(1);
  const mime = ext === "jpg" ? "jpeg" : ext;
  const data = fs.readFileSync(srcFile).toString("base64");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="data:image/${mime};base64,${data}"/></svg>`,
  );
}
