/* Remake runtime. Loaded first on every remade page.
   1. Answers the site's own API calls (fetch and XHR) from the responses recorded during the visit,
      so pages that load their content from an API still work from your copy.
   2. Sends links to pages that weren't remade back to the original site.
   3. Holds back form submissions until you wire them to your own email or tool. */
(function () {
  var CFG = /*__REMAKE_CONFIG__*/ { origin: "", pages: [], net: {} };
  window.__REMAKE__ = CFG;

  function fnv(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }
  function pad(h) {
    while (h.length < 8) h = "0" + h;
    return h;
  }
  function original(url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin === location.origin) return CFG.origin + u.pathname + u.search;
      return u.href;
    } catch (e) {
      return url;
    }
  }
  function lookup(method, url, body) {
    var key = (method || "GET").toUpperCase() + " " + original(url);
    if (body && typeof body === "string") {
      var withBody = CFG.net[key + " #" + pad(fnv(body))];
      if (withBody) return withBody;
    }
    return CFG.net[key] || null;
  }

  if (window.fetch) {
    var realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : input && input.url;
        var method = (init && init.method) || (input && input.method) || "GET";
        var body = init && typeof init.body === "string" ? init.body : "";
        var hit = url && lookup(method, url, body);
        if (hit) {
          return realFetch(hit.file).then(function (res) {
            return res.blob().then(function (blob) {
              return new Response(blob, { status: hit.status || 200, headers: { "content-type": hit.type || blob.type } });
            });
          });
        }
      } catch (e) {}
      return realFetch(input, init);
    };
  }

  var XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    var open = XHR.open;
    var send = XHR.send;
    XHR.open = function (method, url) {
      this.__remake = { method: method, url: url, args: arguments };
      return open.apply(this, arguments);
    };
    XHR.send = function (body) {
      var r = this.__remake;
      var hit = r && lookup(r.method, r.url, typeof body === "string" ? body : "");
      if (hit) {
        var args = Array.prototype.slice.call(r.args);
        args[0] = "GET";
        args[1] = hit.file;
        open.apply(this, args);
        return send.call(this);
      }
      return send.apply(this, arguments);
    };
  }

  try {
    if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error("Service workers are off in a remake.")); };
    navigator.sendBeacon = function () { return true; };
  } catch (e) {}

  function remade(path) {
    var p = path.replace(/\/index\.html$/, "/").replace(/\/+$/, "") || "/";
    for (var i = 0; i < CFG.pages.length; i++) {
      var q = CFG.pages[i].split("?")[0].replace(/\/+$/, "") || "/";
      if (q === p) return true;
    }
    return /^\/_remake(\/|$)/.test(path);
  }

  document.addEventListener(
    "click",
    function (e) {
      var a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a || a.target === "_blank" || e.defaultPrevented) return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#" || /^(mailto|tel|javascript):/i.test(href)) return;
      var u;
      try { u = new URL(href, location.href); } catch (err) { return; }
      if (u.origin !== location.origin) return;
      if (/\.[a-z0-9]{2,5}$/i.test(u.pathname) && !/\.html?$/i.test(u.pathname)) return;
      if (!remade(u.pathname)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        location.href = CFG.origin + u.pathname + u.search + u.hash;
      }
    },
    true,
  );

  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      if (form && form.hasAttribute && form.hasAttribute("data-remake-live")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var note = document.createElement("div");
      note.textContent = "This form isn't connected yet. Tell Claude where it should send messages.";
      note.setAttribute("style", "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;background:#15171b;color:#fff;font:500 14px/1.4 system-ui,sans-serif;padding:12px 16px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25)");
      document.body.appendChild(note);
      setTimeout(function () { note.remove(); }, 4000);
    },
    true,
  );
})();
