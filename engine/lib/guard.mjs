// What Remake refuses to copy, and how it recognises a site that doesn't want automated visits.
import { RemakeError } from "./util.mjs";

const TRACKERS = [
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "doubleclick.net",
  "googleadservices.com",
  "googlesyndication.com",
  "connect.facebook.net",
  "facebook.com/tr",
  "hotjar.com",
  "hotjar.io",
  "clarity.ms",
  "segment.com",
  "segment.io",
  "cdn.segment.com",
  "mixpanel.com",
  "amplitude.com",
  "heap.io",
  "heapanalytics.com",
  "fullstory.com",
  "snap.licdn.com",
  "px.ads.linkedin.com",
  "analytics.tiktok.com",
  "static.ads-twitter.com",
  "bat.bing.com",
  "consent.cookiebot.com",
  "consentcdn.cookiebot.com",
  "cdn.cookielaw.org",
  "onetrust.com",
  "plausible.io",
  "stats.wp.com",
  "pixel.wp.com",
  "js.hs-analytics.net",
  "js.hs-banner.com",
  "js.hsadspixel.net",
  "cdn.usefathom.com",
  "posthog.com",
  "sentry.io",
  "browser.sentry-cdn.com",
  "intercomcdn.com",
  "widget.intercom.io",
  "js.driftt.com",
  "static.zdassets.com",
  "vercel-insights.com",
  "va.vercel-scripts.com",
  "/_vercel/insights",
  "/_vercel/speed-insights",
];

export function isTracker(url) {
  return TRACKERS.some((t) => url.includes(t));
}

export function trackerHost(url) {
  const t = TRACKERS.find((x) => url.includes(x));
  return t || null;
}

const CHALLENGE = [
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
  /cf-browser-verification|challenge-platform|cf_chl_opt/i,
  /<title>\s*Attention Required!/i,
  /<title>\s*One moment, please\.\.\.\s*<\/title>/i,
  /Vercel Security Checkpoint/i,
  /<title>\s*Access denied\s*<\/title>/i,
  /captcha-delivery\.com|geo\.captcha-delivery/i,
  /px-captcha|perimeterx/i,
  /Checking your browser before accessing/i,
  /_Incapsula_Resource|incapsula/i,
  /<title>\s*Verify you are human/i,
  /sgcaptcha|sg-captcha/i,
];

export function looksLikeBotWall(status, html = "") {
  if ([403, 429, 503].includes(status) && CHALLENGE.some((r) => r.test(html))) return true;
  return CHALLENGE.some((r) => r.test(html.slice(0, 20000))) && html.length < 60000;
}

export function botWallError(url) {
  return new RemakeError(
    `${new URL(url).host} shows a bot check to automated visits.`,
    "Remake doesn't get around bot walls. Options: ask the owner, try `remake capture --archive` " +
      "to rebuild from the Internet Archive's copy, or pick another site.",
  );
}

// Run inside the page. Sign-in and payment forms in view mean this is not a page to copy.
export async function sensitiveForms(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const pw = [...document.querySelectorAll('input[type="password"]')].filter(visible).length;
    const card = [
      ...document.querySelectorAll(
        'input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvc" i], input[name*="iban" i], iframe[src*="js.stripe.com"], iframe[src*="checkout"], iframe[name*="card" i]',
      ),
    ].filter(visible).length;
    const forms = [...document.querySelectorAll("form")].map((f) => ({
      action: f.getAttribute("action") || "",
      fields: [...f.querySelectorAll("input, textarea, select")]
        .map((i) => i.getAttribute("type") || i.tagName.toLowerCase())
        .slice(0, 12),
    }));
    return { password: pw, card, forms };
  });
}

export function refuseSensitive(url, risk) {
  if (risk.password > 0 || risk.card > 0) {
    throw new RemakeError(
      `${url} shows a ${risk.password ? "sign-in" : "payment"} form.`,
      "Remake doesn't copy sign-in, checkout or banking pages: a copy of those is a phishing kit. " +
        "Pick a marketing page instead.",
    );
  }
}
