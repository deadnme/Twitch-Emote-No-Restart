// ==UserScript==
// @name         Twitch Emote No-Restart
// @namespace    twitch-emote-no-restart
// @version      2.6.2
// @description  Prevents animated Twitch/7TV/BTTV/FFZ chat emotes from restarting/flickering when a new instance of the same emote is posted. All on-screen copies of an emote share one animation clock.
// @author       deadnme
// @license      GNU GPLv3
// @match        https://www.twitch.tv/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      static-cdn.jtvnw.net
// @connect      cdn.7tv.app
// @connect      cdn.7tv.io
// @connect      cdn.betterttv.net
// @connect      cdn.frankerfacez.com
// @homepageURL  https://github.com/deadnme/Twitch-Emote-No-Restart
// @downloadURL https://update.greasyfork.org/scripts/595615/Twitch%20Emote%20No-Restart.user.js
// @updateURL https://update.greasyfork.org/scripts/595615/Twitch%20Emote%20No-Restart.meta.js
// ==/UserScript==

// Every animated <img> runs its own animation, and Twitch's DOM churn restarts them, so each new
// copy of an emote visibly resets the others. Instead: decode each emote once, keep ONE clock per
// emote, and paint its current frame into a canvas laid over every copy (the <img> goes opacity 0).
// The canvases live in a fixed overlay layer on <body> that Twitch never touches, and are drawn by
// a worker so they keep animating through Twitch's ~280ms main-thread stalls, as native images do.
// Positioning and occlusion (pinned message, popovers, scroller edges) are computed per frame.
// Design notes and measurements for each change are in the git history.

(function () {
  'use strict';

  const CLEANUP_DELAY_MS = 15000;           // keep an emote decoded this long after its last copy goes
  const BITMAP_BUDGET_BYTES = 192 << 20;    // beyond this, free idle emotes oldest-first
  const DECODE_CONCURRENCY = 2;
  const CANVAS_POOL_MAX = 400;
  const OCCLUSION_REFRESH_MS = 200;         // safety-net full re-sample of every emote
  const OCCLUSION_DIRTY_MIN_MS = 50;        // min gap between event-triggered full re-samples
  const OCCLUSION_SAMPLES = 5;
  const OCCLUSION_BUDGET_MS = 3;            // per-frame hit-test budget (round-robins across frames)
  const OCCLUSION_MOVE_MIN_MS = 32;         // min gap between hit-tests of one moving, uncovered emote
  const OCCLUSION_EDGE_INSET = 0.08;        // keep samples off row seams
  const OVERLAY_SCAN_MS = 10000;            // safety-net full page scan for covers
  const OVERLAY_REVALIDATE_MS = 250;
  const OVERLAY_SCAN_BUDGET_MS = 2;
  const OVERLAY_MAX_VIEWPORT_FRACTION = 0.9; // bigger boxes are Twitch's transparent layout layers
  const COVER_ZONE_MAX = 64;

  // ---- Renderer: decoded frames, shared clocks and its own rAF loop ------------------------------
  // Runs in a worker via toString(), so it must not close over anything on the page. If a worker
  // can't start, the same function runs on the page with a synchronous port.
  function renderer(port, C) {
    const states = new Map();   // emote key -> { status, frames, cum, start, bytes, px, insts, ... }
    const insts = new Map();    // canvas id -> { canvas, ctx, st, reqW, reqH, visible, fi }
    const pendingGm = new Map(); // key -> promise callbacks for the page's GM_xmlhttpRequest fallback
    const queue = [], fetched = [];
    let inFlight = 0, totalBytes = 0, framesDrawn = 0;
    const post = (m) => port.postMessage(m);

    // Size variants by nominal HEIGHT (chat emotes render at fixed height, auto width).
    const VARIANTS = [
      [/^(https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[^/]+\/[^/]+\/[^/]+\/)[\d.]+$/, [['1.0', 28], ['2.0', 56], ['3.0', 112]], ''],
      [/^(https:\/\/cdn\.7tv\.(?:app|io)\/emote\/[^/]+\/)\d+x(\.\w+)?$/, [['1x', 32], ['2x', 64], ['3x', 96], ['4x', 128]], ''],
      [/^(https:\/\/cdn\.betterttv\.net\/emote\/[^/]+\/)\d+x(\.\w+)?$/, [['1x', 28], ['2x', 56], ['3x', 112]], ''],
      [/^(https:\/\/cdn\.frankerfacez\.com\/(?:emote|emoticon)\/[^/]+\/animated\/)\d+(\.\w+)?$/, [['1', 32], ['2', 64], ['4', 128]], '.webp'],
      [/^(https:\/\/cdn\.frankerfacez\.com\/(?:emote|emoticon)\/[^/]+\/)\d+(\.\w+)?$/, [['1', 32], ['2', 64], ['4', 128]], ''],
    ];
    // Smallest variant that covers px (a 66-frame 7TV emote at 4x is ~4MB of bitmaps). Twitch URLs
    // end in "#e=0", so the ?query/#fragment is set aside before the $-anchored match.
    function variantFor(url, px) {
      const [, base, tail] = url.match(/^([^?#]*)(.*)$/);
      for (const [re, sizes, defExt] of VARIANTS) {
        const m = base.match(re);
        if (m) return m[1] + (sizes.find(([, h]) => h >= px) || sizes[sizes.length - 1])[0] + (m[2] || defExt) + tail;
      }
      return url;
    }

    function fetchBuf(key, url) {
      fetched.push(url); if (fetched.length > 300) fetched.shift();
      return fetch(url, { mode: 'cors', credentials: 'omit' })
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer().then((buf) => ({ buf, type: r.headers.get('content-type') })); })
        // A CDN without permissive CORS: the page retries with GM_xmlhttpRequest.
        .catch(() => new Promise((resolve, reject) => { pendingGm.set(key, { resolve, reject }); post({ t: 'gmfetch', key, url }); }));
    }

    function enqueue(st) { st.busy = true; queue.push(st); pump(); }
    function pump() {
      while (inFlight < C.concurrency && queue.length) {
        const st = queue.shift();
        if (states.get(st.key) !== st) continue;
        inFlight++;
        decode(st).finally(() => { inFlight--; pump(); });
      }
    }

    async function decode(st) {
      const px = Math.max(8, Math.round(st.px));
      let ok = false;
      try {
        const url = variantFor(st.url, px);
        const { buf, type } = await fetchBuf(st.key, url);
        // 7TV serves AVIF by default; labelling it WebP would fail the decode.
        const ext = url.match(/\.(avif|gif|png|webp)(?:[?#]|$)/i);
        const decoder = new ImageDecoder({ data: buf, type: type || 'image/' + (ext ? ext[1].toLowerCase() : 'webp') });
        await decoder.tracks.ready;
        const count = (decoder.tracks.selectedTrack && decoder.tracks.selectedTrack.frameCount) || 1;
        const frames = [], cum = [];
        let total = 0;
        for (let i = 0; i < count && count > 1; i++) {
          const { image } = await decoder.decode({ frameIndex: i });
          const ms = image.duration / 1000;
          // Malformed emotes report 0/NaN durations; floor them like native GIF playback does.
          cum.push(total += Number.isFinite(ms) && ms > 0 ? Math.max(10, ms) : 100);
          // VideoFrame -> ImageBitmap: drawing raw VideoFrames corrupts some GIF/WebPs.
          try { frames.push(await createImageBitmap(image)); } finally { image.close(); }
        }
        decoder.close();
        if (states.get(st.key) !== st) return frames.forEach((b) => b.close()); // dropped meanwhile
        if (count > 1) {
          if (st.frames) st.frames.forEach((b) => b.close()); // an upgrade: new frames are already in hand
          totalBytes -= st.bytes;
          totalBytes += st.bytes = frames.reduce((n, b) => n + b.width * b.height * 4, 0);
          Object.assign(st, { frames, cum, decodedPx: px, status: 'ready' });
          // The epoch is set once, ever: rewinding it would restart every visible copy.
          st.start = st.start || performance.now();
          ok = true;
        } else st.status = 'static';
        post({ t: 'status', key: st.key, status: st.status });
      } catch (e) {
        // A failed upgrade keeps playing the old frames; only a failed first decode is fatal.
        if (!st.frames) { st.status = 'failed'; post({ t: 'status', key: st.key, status: 'failed' }); }
      }
      st.busy = false;
      if (!ok) return;
      // Resize every copy; one that wanted more than this decode gave may upgrade again.
      st.insts.forEach((inst) => { inst.fi = -1; size(inst); paint(inst); });
      enforceBudget(); // only after 'ready' is posted, or it could overtake an eviction's 'gone'
    }

    function getState(key, url, px) {
      let st = states.get(key);
      if (!st) {
        states.set(key, st = { key, url, px, status: 'loading', frames: null, cum: null, start: 0, bytes: 0, used: 0, decodedPx: 0, busy: false, timer: 0, insts: new Set() });
        enqueue(st);
      }
      clearTimeout(st.timer);
      return st;
    }
    // Only ever frees an emote with nothing on screen, so it can never restart a visible clock.
    function drop(st) {
      if (states.get(st.key) !== st || st.insts.size) return;
      if (st.frames) st.frames.forEach((b) => b.close());
      totalBytes -= st.bytes;
      states.delete(st.key);
      post({ t: 'status', key: st.key, status: 'gone' });
    }
    function enforceBudget() {
      if (totalBytes <= C.budget) return;
      const idle = [...states.values()].filter((s) => s.frames && !s.insts.size).sort((a, b) => a.used - b.used);
      for (const st of idle) { if (totalBytes <= C.budget) break; drop(st); }
    }

    // Buffer = the requested device-pixel size, capped at the decoded bitmap (never an upscale).
    // A request well past the decode (Twitch's hover preview) triggers a sharper re-decode.
    function size(inst) {
      const st = inst.st;
      if (!inst.reqW || !st) return;
      if (st.status === 'ready' && !st.busy && inst.reqH > st.decodedPx * 1.25) { st.px = inst.reqH; enqueue(st); }
      const f = st.frames && st.frames[0];
      const w = Math.max(1, f ? Math.min(inst.reqW, f.width) : inst.reqW);
      const h = Math.max(1, f ? Math.min(inst.reqH, f.height) : inst.reqH);
      if (w === inst.canvas.width && h === inst.canvas.height) return;
      inst.canvas.width = w; inst.canvas.height = h;
      inst.ctx.imageSmoothingQuality = 'high'; // resizing resets context state
      inst.fi = -1;
      if (st.frames) paint(inst);
    }
    // The shared clock's frame for st at time now: binary search over cumulative durations.
    function frameAt(st, now) {
      const cum = st.cum, t = (now - st.start) % cum[cum.length - 1];
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (t < cum[mid]) hi = mid; else lo = mid + 1; }
      return lo;
    }
    // Draws at once rather than at the next rAF, because the page may show the canvas before then.
    // Pixels persist, so an unchanged frame is skipped.
    function paint(inst, fi = frameAt(inst.st, performance.now())) {
      if (inst.fi === fi) return;
      try {
        inst.ctx.clearRect(0, 0, inst.canvas.width, inst.canvas.height);
        inst.ctx.drawImage(inst.st.frames[fi], 0, 0, inst.canvas.width, inst.canvas.height);
        inst.fi = fi; framesDrawn++;
      } catch (e) { inst.visible = false; post({ t: 'drawError', id: inst.id }); }
    }
    function unbind(inst) {
      const st = inst.st;
      if (!st) return;
      st.insts.delete(inst);
      inst.st = null; inst.visible = false; inst.fi = -1;
      if (!st.insts.size) st.timer = setTimeout(() => drop(st), C.cleanupMs);
    }

    (function loop() {
      const now = performance.now();
      for (const st of states.values()) {
        if (!st.frames || !st.insts.size) continue;
        st.used = now;
        const fi = frameAt(st, now);
        for (const inst of st.insts) if (inst.visible) paint(inst, fi);
      }
      requestAnimationFrame(loop);
    })();

    port.onmessage = ({ data: m }) => {
      let inst = insts.get(m.id);
      if (m.t === 'bind') {
        if (!inst) insts.set(m.id, inst = { id: m.id, canvas: m.canvas, ctx: m.canvas.getContext('2d'), st: null, reqW: 0, reqH: 0, visible: false, fi: -1 });
        unbind(inst);
        inst.st = getState(m.key, m.url, m.px);
        inst.st.insts.add(inst);
        inst.st.used = performance.now();
        size(inst);
        // A reused canvas still holds its previous emote: repaint it now, or blank it if this
        // emote isn't decoded yet (the page keeps it hidden until then anyway).
        if (inst.st.frames) paint(inst); else inst.ctx.clearRect(0, 0, inst.canvas.width, inst.canvas.height);
      } else if (m.t === 'gm') {
        const p = pendingGm.get(m.key);
        pendingGm.delete(m.key);
        if (p) m.buf ? p.resolve(m) : p.reject(new Error('GM fetch failed'));
      } else if (m.t === 'stats') {
        post({ t: 'stats', framesDrawn, states: states.size, instances: insts.size, bitmapBytes: totalBytes, fetched: fetched.slice() });
      } else if (!inst) {
        return;
      } else if (m.t === 'unbind') { // parked in the page's pool (context kept) or dropped
        unbind(inst);
        if (m.drop) insts.delete(m.id);
      } else if (m.t === 'size') {
        inst.reqW = m.w; inst.reqH = m.h; size(inst);
      } else if (m.t === 'vis') {
        inst.visible = m.on;
        if (m.on && inst.st && inst.st.frames) paint(inst);
      }
    };
  }

  let RENDERER = null, OFFSCREEN = false;
  const STATUS = new Map();    // emote key -> renderer status: loading | ready | static | failed
  const INSTANCES = new Map(); // <img> -> its canvas and occlusion bookkeeping
  // Parked canvases whose context stays alive in the renderer: creating and destroying a GPU
  // context per emote starved rAF for whole seconds in fast chat.
  const POOL = [];
  const statsWaiters = [];
  let overlayLayer = null, nextId = 1;

  function startRenderer() {
    const C = { budget: BITMAP_BUDGET_BYTES, concurrency: DECODE_CONCURRENCY, cleanupMs: CLEANUP_DELAY_MS };
    try {
      if (!HTMLCanvasElement.prototype.transferControlToOffscreen) throw new Error('no OffscreenCanvas');
      const w = new Worker(URL.createObjectURL(new Blob([`(${renderer})(self, ${JSON.stringify(C)})`], { type: 'text/javascript' })));
      w.onmessage = onRendererMessage;
      OFFSCREEN = true;
      return w;
    } catch (e) {
      const toPage = { postMessage: (data) => onRendererMessage({ data }) };
      renderer(toPage, C);
      return { postMessage: (data) => toPage.onmessage({ data }) };
    }
  }

  function onRendererMessage({ data: m }) {
    if (m.t === 'status') {
      if (m.status === 'gone') STATUS.delete(m.key); else STATUS.set(m.key, m.status);
    } else if (m.t === 'drawError') {
      for (const inst of INSTANCES.values()) if (inst.id === m.id) inst.drawFailed = true;
    } else if (m.t === 'stats') {
      statsWaiters.splice(0).forEach((resolve) => resolve(m));
    } else if (m.t === 'gmfetch') {
      const fail = () => RENDERER.postMessage({ t: 'gm', key: m.key });
      if (typeof GM_xmlhttpRequest !== 'function') return fail();
      GM_xmlhttpRequest({
        method: 'GET', url: m.url, responseType: 'arraybuffer', onerror: fail,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300 || !res.response) return fail();
          const ct = /content-type:\s*([^\r\n;]+)/i.exec(res.responseHeaders || '');
          RENDERER.postMessage({ t: 'gm', key: m.key, buf: res.response, type: ct ? ct[1].trim() : '' }, [res.response]);
        },
      });
    }
  }

  function ensureOverlayLayer() {
    if (overlayLayer && overlayLayer.isConnected) return overlayLayer;
    overlayLayer = document.createElement('div');
    overlayLayer.id = 'tenr-overlay-layer';
    // Max z-index: occlusion decides what may cover an emote. Anything lower hid the canvases
    // behind Twitch's own hover-preview tooltip.
    overlayLayer.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647';
    // Diagnostics for the test rig.
    overlayLayer.__tenrStats = () => new Promise((resolve) => { statsWaiters.push(resolve); RENDERER.postMessage({ t: 'stats' }); });
    return document.body.appendChild(overlayLayer);
  }

  // ---- Emote detection ---------------------------------------------------------------------------

  const URL_PATTERNS = [
    ['twitch', /static-cdn\.jtvnw\.net\/emoticons\/v2\/([^/]+)\//],
    ['7tv', /cdn\.7tv\.(?:app|io)\/emote\/([^/]+)/],
    ['bttv', /cdn\.betterttv\.net\/emote\/([^/]+)/],
    ['ffz', /cdn\.frankerfacez\.com\/(?:emote|emoticon)\/(\d+)/],
  ];
  function keyForUrl(url) {
    for (const [name, re] of URL_PATTERNS) { const m = url && url.match(re); if (m) return name + ':' + m[1]; }
    return null;
  }
  // Attributes first (largest srcset candidate): they change in the same mutation that fires the
  // observer, while currentSrc can lag a frame on a recycled <img> and name the previous emote.
  function emoteOf(img) {
    const srcset = (img.getAttribute('srcset') || '').split(',').map((s) => s.trim().split(/\s+/)[0]).reverse();
    const url = [...srcset, img.getAttribute('src'), img.currentSrc].find(keyForUrl);
    return url ? { url, key: keyForUrl(url) } : null;
  }

  // Deliberately not limited to chat: a selector allowlist silently broke whenever Twitch's markup
  // didn't match it. Pickers and previews cost a few extra decodes that self-clean.
  function attach(img) {
    if (INSTANCES.has(img)) return;
    const e = emoteOf(img);
    if (!e) return;
    const layer = ensureOverlayLayer();
    let canvas = POOL.pop(), transfer = null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'tenr-canvas';
      canvas.width = canvas.height = 1; // the default 300x150 buffer would be committed per instance
      canvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;display:none';
      canvas.tenrId = nextId++;
      transfer = OFFSCREEN ? canvas.transferControlToOffscreen() : canvas;
    }
    if (canvas.parentNode !== layer) layer.appendChild(canvas);
    canvas.removeAttribute('data-parked');
    // insets: undefined = not yet sampled, null = fully covered, else a {top,bottom} crop.
    const inst = { canvas, key: e.key, id: canvas.tenrId, hidden: false, visible: false, drawFailed: false, bmpW: 1, bmpH: 1,
      clip: undefined, row: undefined, insets: undefined, lastRect: null, lastSampleAt: -Infinity,
      srcset: img.getAttribute('srcset'), src: img.getAttribute('src') };
    INSTANCES.set(img, inst);
    RENDERER.postMessage({ t: 'bind', id: inst.id, canvas: transfer, key: e.key, url: e.url, px: Math.ceil(28 * (devicePixelRatio || 1)) }, OFFSCREEN && transfer ? [transfer] : []);
    // Already decoded: hide the native <img> in this same task, so a repeat copy never shows its
    // own frame 0 before the canvas draws it on the shared clock.
    if (STATUS.get(e.key) === 'ready') { img.style.opacity = '0'; inst.hidden = true; }
  }

  function detach(img) {
    const inst = INSTANCES.get(img);
    if (!inst) return;
    INSTANCES.delete(img);
    const park = !inst.drawFailed && POOL.length < CANVAS_POOL_MAX;
    RENDERER.postMessage({ t: 'unbind', id: inst.id, drop: !park });
    if (park) { inst.canvas.style.display = 'none'; inst.canvas.setAttribute('data-parked', ''); POOL.push(inst.canvas); }
    else inst.canvas.remove();
    if (inst.hidden) img.style.opacity = '';
  }

  // ---- Chat geometry -----------------------------------------------------------------------------

  // Nearest genuinely scrollable ancestor (the message list). overflow:hidden alone is common for
  // unrelated reasons and would clip emotes to some small wrapper.
  function findScrollClipAncestor(el) {
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.clientHeight >= 120) return n;
    }
    return null;
  }
  // The scroller's child that contains img: "this message's own subtree". Anything painted inside
  // it (hover highlight, badges) isn't occlusion; anything outside it (a pinned message) is.
  function findRowRoot(img, clip) {
    if (!clip) return null;
    let n = img;
    while (n.parentElement && n.parentElement !== clip) n = n.parentElement;
    return n.parentElement === clip ? n : null;
  }

  // Rebuilt every occlusion sweep. A DOM change inside a known row can't add a foreign cover.
  let knownRows = new Set(), knownClips = new Set();
  const insideAny = (set, node) => { for (const el of set) if (el.contains(node)) return true; return false; };
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const offscreen = (r) => r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  // ---- Cover detection ---------------------------------------------------------------------------
  // Hit-testing every emote every frame is too slow, so emotes are only hit-tested when they overlap
  // a tracked "cover zone". Zones come from newly added subtrees (via the observer), a periodic
  // revalidation, and a rare time-sliced full-page scan as a safety net.

  let covers = [], blind = [];  // cover zones; the pointer-events:none subset elementFromPoint can't see
  let pendingNodes = [], scan = null, lastFullScan = -Infinity, lastRevalidate = -Infinity;

  // Only something that paints can cover (Twitch mounts full-viewport transparent layers).
  function paints(cs) {
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const m = /^rgba?\(([^)]+)\)/i.exec(cs.backgroundColor);
    const alpha = m && m[1].split(',')[3];
    return !!m && (alpha === undefined || parseFloat(alpha) > 0.05);
  }
  // Twitch's pinned message is a painted card inside a transparent absolute wrapper, so the test is
  // painted content, not a painted element. Bounded: real covers are small.
  function hasPaintedDescendant(el) {
    if (paints(getComputedStyle(el))) return true;
    const kids = el.querySelectorAll('*');
    for (let i = 0; i < kids.length && i < 200; i++) {
      const r = kids[i].getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8 && paints(getComputedStyle(kids[i]))) return true;
    }
    return false;
  }
  // 0 = can't cover an emote; 1 = cover zone; 2 = cover zone elementFromPoint can't see.
  function coverKind(el) {
    if (el === overlayLayer || el.parentElement === overlayLayer || !el.isConnected) return 0;
    const cs = getComputedStyle(el), pos = cs.position;
    if (pos !== 'fixed' && pos !== 'sticky' && pos !== 'absolute') return 0;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return 0;
    // An absolute element inside the scroller (badges, 7TV overlays) scrolls WITH the messages.
    if (pos === 'absolute' && insideAny(knownClips, el)) return 0;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return 0;
    // Must overlap a chat scroller (none tracked yet: accept, the next refresh prunes).
    if (knownClips.size && ![...knownClips].some((c) => c.isConnected && overlaps(r, c.getBoundingClientRect()))) return 0;
    if (!hasPaintedDescendant(el)) return 0;
    return pos !== 'absolute' && cs.pointerEvents === 'none' && paints(cs) ? 2 : 1;
  }

  const newScan = () => ({ zones: [], blind: [], seen: new Set() });
  function consider(s, el) {
    if (s.seen.has(el)) return;
    s.seen.add(el);
    const kind = coverKind(el);
    if (kind && s.zones.length < COVER_ZONE_MAX) s.zones.push(el);
    if (kind === 2) s.blind.push(el);
  }
  function commit(s) {
    if (!sameList(covers, s.zones) || !sameList(blind, s.blind)) occlusionDirty = true;
    covers = s.zones; blind = s.blind;
  }
  function refreshCovers() {
    const s = newScan();
    for (const el of covers.concat(blind)) consider(s, el);
    for (const node of pendingNodes) {
      if (!node.isConnected) continue;
      consider(s, node);
      // A banner often mounts as a wrapper around the part that paints.
      const kids = node.querySelectorAll('*');
      for (let i = 0; i < kids.length && i < 2000; i++) consider(s, kids[i]);
    }
    pendingNodes = [];
    commit(s);
  }
  function stepCoverScan(now) {
    if (!scan) {
      const fullDue = now - lastFullScan >= OVERLAY_SCAN_MS;
      // New subtrees are checked at once: a banner must be clipped the frame it mounts.
      if (pendingNodes.length || (!fullDue && covers.length && now - lastRevalidate >= OVERLAY_REVALIDATE_MS)) {
        lastRevalidate = now;
        return refreshCovers();
      }
      if (!fullDue) return;
      // Catches covers that appear without a DOM addition (a class flip to position:fixed).
      scan = Object.assign(newScan(), { list: document.body.querySelectorAll('*'), i: 0 });
    }
    const deadline = performance.now() + OVERLAY_SCAN_BUDGET_MS;
    while (scan.i < scan.list.length) {
      if ((scan.i & 63) === 0 && performance.now() > deadline) return; // continue next frame
      consider(scan, scan.list[scan.i++]);
    }
    commit(scan);
    scan = null;
    lastFullScan = performance.now(); // stamped on completion, or a long scan restarts at once
  }

  // Cover rects, read once per frame and shared by every emote (reset in tick).
  const frameRects = new Map();
  function coverRects(els, img) {
    let list = frameRects.get(els);
    if (!list) {
      const f = OVERLAY_MAX_VIEWPORT_FRACTION;
      list = [];
      for (const el of els) {
        const r = el.isConnected && el.getBoundingClientRect();
        if (r && r.width >= 1 && r.height >= 1 && !(r.width >= innerWidth * f && r.height >= innerHeight * f)) list.push([el, r]);
      }
      frameRects.set(els, list);
    }
    return list.filter(([el]) => !el.contains(img) && !img.contains(el)).map(([, r]) => r); // own subtree isn't a cover
  }
  const intersectsCover = (img, rect) => covers.length > 0 && coverRects(covers, img).some((r) => overlaps(rect, r));

  // ---- Occlusion ---------------------------------------------------------------------------------

  const ZERO = { top: 0, bottom: 0 };
  let lastFullOcclusion = -Infinity, occlusionCursor = 0, occlusionDirty = true;

  // Samples points down the emote. Returns top/bottom crop insets, or null if fully covered: a
  // majority vote would draw an emote in full over a banner covering less than half of it.
  function occlusionInsets(img, row, rect) {
    const x = rect.left + rect.width / 2;
    if (x < 0 || x >= innerWidth) return ZERO;
    const boundary = row || img, blindRects = blind.length ? coverRects(blind, img) : [];
    let first = -1, last = -1, sampled = 0, visTop = 0, visBottom = 0;
    for (let i = 0; i < OCCLUSION_SAMPLES; i++) {
      const y = rect.top + rect.height * (OCCLUSION_EDGE_INSET + (1 - 2 * OCCLUSION_EDGE_INSET) * i / (OCCLUSION_SAMPLES - 1));
      if (y < 0 || y >= innerHeight) continue;
      sampled++;
      if (blindRects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) continue;
      // Visible = the hit lands in this emote's own row, so Twitch's hover UI there isn't a cover.
      const hit = document.elementFromPoint(x, y);
      if (hit && (boundary.contains(hit) || hit.contains(boundary))) {
        if (first < 0) { first = i; visTop = y; }
        last = i; visBottom = y;
      }
    }
    if (first < 0) return sampled ? null : ZERO; // nothing testable means unknown, not covered
    // The outer samples sit EDGE_INSET inside the emote; an edge whose outer sample is visible
    // isn't covered at all, so it gets no crop.
    return {
      top: first === 0 ? 0 : Math.max(0, visTop - rect.top),
      bottom: last === OCCLUSION_SAMPLES - 1 ? 0 : Math.max(0, rect.bottom - visBottom),
    };
  }

  // Moved emotes are re-sampled at once (a row scrolling under the pinned message); stationary ones
  // only on a full sweep: when something outside the rows changed, or every OCCLUSION_REFRESH_MS.
  function updateOcclusion(now, live) {
    stepCoverScan(now);
    const full = now - lastFullOcclusion >= OCCLUSION_REFRESH_MS || (occlusionDirty && now - lastFullOcclusion >= OCCLUSION_DIRTY_MIN_MS);
    if (full) { occlusionDirty = false; lastFullOcclusion = now; } // on schedule: a truncated sweep still counts
    const rows = new Set(), clips = new Set(), fresh = [], due = [];
    const sample = ({ img, inst, rect }) => {
      if (!inst.clip || !inst.clip.isConnected) {
        inst.clip = findScrollClipAncestor(img);
        inst.row = findRowRoot(img, inst.clip);
      } else if (inst.row === undefined || (inst.row && !inst.row.isConnected)) {
        inst.row = findRowRoot(img, inst.clip);
      }
      if (inst.row) rows.add(inst.row);
      if (inst.clip) clips.add(inst.clip);
      inst.insets = !full && !intersectsCover(img, rect) ? ZERO : occlusionInsets(img, inst.row, rect);
      inst.lastRect = rect;
      inst.lastSampleAt = now;
    };
    for (const entry of live) {
      const { img, inst, rect } = entry, last = inst.lastRect;
      if (!rect) continue;
      if (inst.row) rows.add(inst.row);
      if (inst.clip) clips.add(inst.clip);
      if (!rect.width || !rect.height) { inst.insets = null; inst.lastRect = null; }
      else if (offscreen(rect)) { inst.insets = ZERO; inst.lastRect = rect; }
      else if (inst.insets === undefined) fresh.push(entry);
      else if (full || (!(last && Math.abs(rect.top - last.top) < 0.5 && Math.abs(rect.left - last.left) < 0.5 &&
          Math.abs(rect.width - last.width) < 0.5 && Math.abs(rect.height - last.height) < 0.5) &&
          // During autoscroll every emote moves every frame; an uncovered one can wait a couple.
          (now - inst.lastSampleAt >= OCCLUSION_MOVE_MIN_MS || intersectsCover(img, rect)))) due.push(entry);
    }
    // Never-sampled emotes go first: tick() won't draw them until they have insets.
    fresh.forEach(sample);
    // The rest round-robin within a budget. A skipped emote keeps its crop but is still positioned
    // from its fresh rect, so the canvas can't drift behind its <img>.
    const n = due.length, start = n ? occlusionCursor % n : 0, deadline = performance.now() + OCCLUSION_BUDGET_MS;
    let done = 0;
    while (done < n) {
      sample(due[(start + done++) % n]);
      if ((done & 7) === 0 && performance.now() > deadline) break;
    }
    if (n) occlusionCursor = (start + done) % n;
    knownRows = rows; knownClips = clips;
  }

  // Scroller clip + occlusion crop as one clip-path; null if nothing would remain visible.
  function clipPathFor(rect, c, insets) {
    const top = Math.max(0, insets.top, c ? c.top - rect.top : 0), bottom = Math.max(0, insets.bottom, c ? rect.bottom - c.bottom : 0);
    const left = c ? Math.max(0, c.left - rect.left) : 0, right = c ? Math.max(0, rect.right - c.right) : 0;
    if (top + bottom >= rect.height - 0.5 || left + right >= rect.width - 0.5) return null;
    return top || right || bottom || left ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : 'none';
  }

  // ---- Frame loop: all reads, then all writes ----------------------------------------------------

  function tick() {
    const now = performance.now(), dpr = devicePixelRatio || 1;
    frameRects.clear();
    const live = [];
    for (const [img, inst] of INSTANCES) live.push({ img, inst, rect: img.isConnected ? img.getBoundingClientRect() : null });
    updateOcclusion(now, live);

    const clipRects = new Map(), work = [];
    for (const { img, inst, rect } of live) {
      if (!rect) { work.push([img, inst, 'detach']); continue; }
      // Safety net beside the observer: src/srcset now names a different emote.
      const ss = img.getAttribute('srcset'), sa = img.getAttribute('src');
      if (ss !== inst.srcset || sa !== inst.src) {
        inst.srcset = ss; inst.src = sa;
        const e = emoteOf(img);
        if (e && e.key !== inst.key) { work.push([img, inst, 'reattach']); continue; }
      }
      let clip = null;
      if (STATUS.get(inst.key) === 'ready' && !inst.drawFailed && inst.insets && rect.width && rect.height && !offscreen(rect)) {
        let c = null;
        if (inst.clip && inst.clip.isConnected) {
          c = clipRects.get(inst.clip);
          if (!c) clipRects.set(inst.clip, c = inst.clip.getBoundingClientRect());
        }
        clip = clipPathFor(rect, c, inst.insets);
      }
      work.push([img, inst, clip === null ? 'hide' : 'draw', rect, clip]);
    }

    for (const [img, inst, action, rect, clip] of work) {
      const s = inst.canvas.style;
      if (action === 'detach') detach(img);
      else if (action === 'reattach') { detach(img); attach(img); }
      else if (action === 'hide') {
        // Loading, static, failed, off screen or covered: show the native <img>, never a hole.
        if (s.display !== 'none') s.display = 'none';
        if (inst.visible) { inst.visible = false; RENDERER.postMessage({ t: 'vis', id: inst.id, on: false }); }
        if (inst.hidden) { img.style.opacity = ''; inst.hidden = false; }
      } else {
        // opacity, not visibility: a visibility:hidden <img> drops out of Twitch's hover/click.
        if (!inst.hidden) { img.style.opacity = '0'; inst.hidden = true; }
        // Guarded writes: re-assigning an identical value still dirties style.
        const tf = `translate3d(${rect.left}px, ${rect.top}px, 0)`, w = rect.width + 'px', h = rect.height + 'px';
        if (inst.tf !== tf) s.transform = inst.tf = tf;
        if (inst.w !== w) s.width = inst.w = w;
        if (inst.h !== h) s.height = inst.h = h;
        if (inst.cp !== clip) s.clipPath = inst.cp = clip;
        // Buffer = on-screen size x DPR. Grow at once, shrink only past 2x, so the hover preview's
        // scale animation doesn't reallocate the canvas every frame.
        const bw = Math.max(1, Math.round(rect.width * dpr)), bh = Math.max(1, Math.round(rect.height * dpr));
        if (bw > inst.bmpW || bh > inst.bmpH || bw * 2 < inst.bmpW || bh * 2 < inst.bmpH) {
          inst.bmpW = bw; inst.bmpH = bh;
          RENDERER.postMessage({ t: 'size', id: inst.id, w: bw, h: bh });
        }
        if (!inst.visible) { inst.visible = true; RENDERER.postMessage({ t: 'vis', id: inst.id, on: true }); }
        if (s.display) s.display = '';
      }
    }
    requestAnimationFrame(tick);
  }

  // ---- Boot --------------------------------------------------------------------------------------

  function scanNode(node) {
    if (!(node instanceof Element) || node === overlayLayer) return;
    if (pendingNodes.length < 256) pendingNodes.push(node); // cover candidate
    if (node.tagName === 'IMG') attach(node); else node.querySelectorAll('img').forEach(attach);
  }
  function detachRemoved(node) {
    if (!(node instanceof Element) || !INSTANCES.size) return;
    for (const img of node.tagName === 'IMG' ? [node] : [...node.getElementsByTagName('img')]) {
      if (!INSTANCES.has(img)) continue;
      detach(img);
      if (img.isConnected) attach(img); // moved, not removed: re-derive its scroller and row
    }
  }
  // Could this mutation cover an emote without moving it? A new message lands on the scroller
  // itself and only moves rows, which the per-emote rect check already catches.
  const mayChangeLayering = (m) => m.type === 'childList' && !knownClips.has(m.target) &&
    [...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1) && !insideAny(knownRows, m.target);
  // A popover opening or a banner sliding in can cover emotes without moving them; events inside
  // chat rows (hover highlights, row animations) can't, and fire constantly.
  function onUiEvent(e) {
    if (!occlusionDirty && !(e.target instanceof Node && insideAny(knownRows, e.target))) occlusionDirty = true;
  }

  function boot() {
    RENDERER = startRenderer();
    ensureOverlayLayer();
    document.querySelectorAll('img').forEach(attach);
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.target === overlayLayer) continue; // our own canvases
        if (!occlusionDirty && mayChangeLayering(m)) occlusionDirty = true;
        if (m.type === 'childList') {
          m.addedNodes.forEach(scanNode);
          m.removedNodes.forEach(detachRemoved);
        } else if (m.target.tagName === 'IMG') {
          // Rebind only for a *different recognised* emote: extensions rewrite src to blob:/data:
          // once they have cached an emote, and that isn't a change of emote.
          const inst = INSTANCES.get(m.target), e = emoteOf(m.target);
          if (e && (!inst || inst.key !== e.key)) { detach(m.target); attach(m.target); }
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    for (const type of ['click', 'transitionend', 'animationend']) document.addEventListener(type, onUiEvent, { capture: true, passive: true });
    addEventListener('resize', () => { occlusionDirty = true; lastFullScan = -Infinity; }, { passive: true });
    requestAnimationFrame(tick);
  }

  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
