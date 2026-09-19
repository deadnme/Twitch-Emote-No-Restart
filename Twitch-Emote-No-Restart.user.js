// ==UserScript==
// @name         Twitch Emote No-Restart
// @namespace    twitch-emote-no-restart
// @version      2.6.0
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

// ---------------------------------------------------------------------
// THE PROBLEM (from the original bug report this script exists to fix):
// with BTTV/FFZ/7TV all installed, every time an animated emote (SourPls,
// PepePls, etc.) is posted while another copy is already on screen, ALL
// copies visibly reset to frame 0 — because each <img> is animating that
// GIF/WebP/APNG independently via the browser's native image decoder, and
// Twitch's own DOM churn (new message -> reflow/recycle) restarts them.
//
// THE FIX: never let the browser animate the <img> itself. Decode each
// unique emote once into a plain frame array, keep ONE shared virtual
// "clock" per emote (an epoch timestamp), and paint that same frame into
// a canvas laid over every on-screen copy. Adding a new copy only ever
// reads the existing clock — it can't rewind it, and it can't be rewound
// by anything Twitch does to the DOM, because the canvases live in a
// persistent overlay layer on document.body, independent of whatever
// <img> nodes Twitch creates, destroys, or recycles underneath them.
//
// v2.3.0 / v2.4.0 / v2.4.1: occlusion (pinned Predict banner, pinned chat
// message, sticky header ...) via elementFromPoint sampling + a scan for
// pointer-events:none overlays; immediate native-<img> hide for repeat
// instances; self-occlusion / invisible-wrapper / bogus-duration fixes.
//
// v2.6.0: frames are now painted by a dedicated worker (OffscreenCanvas).
// A performance trace on a live channel showed Twitch's own websocket
// handler blocking the main thread for ~280ms every ~30s. Native animated
// images keep animating through a main-thread stall; a canvas repainted from
// requestAnimationFrame on the page cannot, so the script had been turning a
// near-invisible stall into a visible one on every animated emote. The worker
// owns the decoded frames, the shared per-emote clocks and its own rAF loop,
// and commits straight to the compositor: measured 216 frame draws during a
// deliberate 600ms main-thread block (the old renderer: 0). Placeholder
// canvases are pooled so fast chat reuses contexts instead of churning them.
// If a worker can't be created, the main-thread renderer is used unchanged.
//
// v2.5.0: the canvas drifting out of position during fast chat, plus a
// rendering bug that had been cropping every animated emote.
//
// Drift happens when the rAF loop misses frames: the <img> is real DOM and
// moves with every paint as chat scrolls, while the canvas only catches up
// when tick() next runs. So the fix is to keep the frame budget free.
//   (1) v2.4.2 meant to stop new chat messages from forcing a full occlusion
//       re-sample, but mutationMayChangeLayering() only excluded mutations
//       whose target was INSIDE a chat row. A new message is appended to the
//       row *list*, so the target is the scroll container -- outside every
//       rowRoot -- and every single message still marked the sweep dirty.
//       Tracked clip ancestors are now excluded too. (Measured on a 20 msg/s
//       harness: ~7900 forced elementFromPoint hit-tests per second, gone.)
//   (2) Occlusion sampling is capped at OCCLUSION_BUDGET_MS per frame and
//       round-robins across frames. This is what makes drift impossible under
//       load: an emote that misses the cap keeps its cached insets but is
//       STILL repositioned from its fresh rect, so the canvas cannot fall
//       behind its <img>. Only the crop goes briefly stale.
//   (3) An emote is only hit-tested when it actually overlaps something
//       out-of-flow that paints. Clipping by the scroll container was always
//       pure geometry (computeClipPath's cRect) and never needed a hit-test;
//       the samples are only for foreign covers. ~75% of samples now skip.
//   (4) The pointer-events overlay scan no longer re-walks the whole page.
//       It stamped its timer at the *start* of a scan, so by the time a long
//       scan finished the next was already due -- a permanent ~2ms/frame tax
//       that grew with page size. Candidacy is now driven off the
//       MutationObserver, with a rare full rescan as a safety net.
//       (~6700 getComputedStyle calls/second -> a few hundred.)
//   (5) currentFrameIndex() is resolved once per emote per frame over
//       precomputed cumulative offsets, not once per on-screen copy via a
//       linear scan. Every copy shares one clock, so the value was identical.
//   (6) One getBoundingClientRect per instance per frame, shared between the
//       occlusion pass and the draw pass (each used to take its own).
//   (7) Decodes are queued at DECODE_CONCURRENCY instead of all starting at
//       once when a burst of unseen emotes arrives.
//   (8) The transform write is guarded like the width/height/clipPath writes.
//
// Also fixed, and unrelated to speed:
//   (9) computeOcclusionInsets() turned sample POSITIONS into crop insets,
//       and the outermost samples sit OCCLUSION_EDGE_INSET (8%) inside the
//       emote to avoid row-seam false positives. So every animated emote was
//       cropped 8% off the top and 8% off the bottom -- 16% of a 28px chat
//       emote -- even with nothing whatsoever covering it. An edge whose
//       outermost sample is visible now gets a zero inset.
//  (10) upgradeToHighestQuality() anchors every pattern with $, but Twitch
//       serves emote URLs with a "#e=0" fragment, so every pattern missed and
//       the function returned the 1.0 (28px) variant it was written to avoid.
//       Any #fragment / ?query is now set aside before matching.
//
// v2.4.2: fixes emotes lagging behind during very fast chat. Nothing about
// decoding, image quality, the shared clock or occlusion *results* changed
// — only how often and when the expensive work runs.
//   (1) The occlusion sweep was effectively running a FULL re-sample of
//       every emote on every frame in fast chat: every DOM mutation,
//       scroll, transitionend and animationend set the dirty flag, and a
//       dirty sweep bypassed the "hasn't moved, keep cached insets" check
//       (the opposite of what its comment said). That is 5 forced
//       elementFromPoint hit-tests per emote per frame. Now:
//         - an emote whose rect moved is re-sampled that same frame (so a
//           row scrolling up under the pinned message is clipped exactly
//           as before, with no delay);
//         - a FULL re-sample of stationary emotes only happens when
//           something OUTSIDE the chat rows changed (a banner / pinned
//           message mounting, a popover, a resize), capped at one per
//           OCCLUSION_DIRTY_MIN_MS, plus a safety-net full sweep every
//           OCCLUSION_REFRESH_MS. New chat messages only move rows, which
//           the per-emote move check already handles.
//   (2) Our own canvases being appended to the overlay layer triggered the
//       MutationObserver, which marked the sweep dirty on every attach.
//       Mutations inside our overlay layer are now ignored.
//   (3) The pointer-events overlay scan did querySelectorAll('*') plus
//       getComputedStyle on the ENTIRE page in a single frame once a
//       second — a periodic hitch that grows with chat size. It is now
//       time-sliced (OVERLAY_SCAN_BUDGET_MS per frame). Same checks, same
//       results, spread over a few frames.
//   (4) attachInstance forced a synchronous layout (getBoundingClientRect
//       + elementFromPoint) inside the MutationObserver callback, between
//       DOM writes — N forced layouts for a burst of N emotes. That check
//       never made the canvas appear sooner (drawing only happens in
//       tick(), which always runs before the next paint), so the new
//       instance's occlusion is now computed in tick()'s read phase.
//   (5) Removed chat rows were checked against EVERY tracked instance with
//       contains(). Now only the <img>s inside the removed subtree are
//       looked up.
//   (6) Every canvas was cleared + redrawn every frame even when the
//       shared clock was still on the same frame. The redraw is skipped
//       when the frame index hasn't changed (pixels are identical).
// ---------------------------------------------------------------------

(function () {
  'use strict';

  const CLEANUP_DELAY_MS = 15000;      // keep a decoded emote cached this long after its last instance disappears
  // v2.5.1: ceiling on decoded frame memory. A single animated 7TV emote is
  // far heavier than a Twitch one — measured 66 frames at 128x128 = 4.1MB of
  // ImageBitmaps each — and a busy channel cycles through hundreds of distinct
  // emotes, so "free it 15s after its last instance" alone let this grow
  // without bound. Only emotes with nothing on screen are ever freed, so this
  // can never rewind a clock that is still visible.
  const BITMAP_BUDGET_BYTES = 192 * 1024 * 1024;
  const OCCLUSION_REFRESH_MS = 200;    // safety-net FULL re-sample of every on-screen emote
  const OCCLUSION_DIRTY_MIN_MS = 50;   // min gap between event-triggered FULL re-samples (moved emotes are always re-sampled immediately)
  const OCCLUSION_SAMPLES = 5;
  const OCCLUSION_BUDGET_MS = 3;       // max time per frame spent re-sampling occlusion (v2.5.0)
  const OCCLUSION_MOVE_MIN_MS = 32;    // min gap between hit-tests of the SAME moving emote (v2.5.0)
  const OCCLUSION_EDGE_INSET = 0.08;   // keep samples off the exact top/bottom edge (avoids row-seam false positives)

  // Supplementary detection for overlays that elementFromPoint can't see
  // because they (or a wrapper) set pointer-events: none. Cheap to keep
  // enabled; flip to false if you'd rather not pay the periodic scan.
  const DETECT_POINTER_EVENTS_OVERLAYS = true;
  const OVERLAY_SCAN_MS = 10000;       // v2.5.0: safety-net full rescan only (was 1000, and effectively continuous)
  const OVERLAY_REVALIDATE_MS = 250;   // how often the small candidate list is re-tested (v2.5.0)
  const OVERLAY_SCAN_BUDGET_MS = 2;    // max time per frame spent on that scan (it's spread over several frames)

  // A pointer-events:none candidate wider/taller than this fraction of the
  // viewport is treated as a layout wrapper, not a real cover. Twitch's
  // tooltip/toast/drag layers are exactly this: full-screen, transparent,
  // and they would otherwise "occlude" every emote on the page.
  const OVERLAY_MAX_VIEWPORT_FRACTION = 0.9;
  const COVER_ZONE_MAX = 64;           // cap on tracked potential covers (v2.5.0)

  const URL_PATTERNS = [
    { name: 'twitch', re: /static-cdn\.jtvnw\.net\/emoticons\/v2\/([^/]+)\// },
    { name: '7tv', re: /cdn\.7tv\.(?:app|io)\/emote\/([^/]+)/ },
    { name: 'bttv', re: /cdn\.betterttv\.net\/emote\/([^/]+)/ },
    { name: 'ffz', re: /cdn\.frankerfacez\.com\/(?:emote|emoticon)\/(\d+)/ },
  ];

  const STATE_MAP = new Map();   // emote key -> shared decoded animation state
  let totalBitmapBytes = 0;

  // ---- v2.6.0: worker renderer -------------------------------------------
  //
  // Traced on a live channel: every ~30s Twitch's own websocket handler
  // blocks the main thread for ~280ms. Text and scrolling freeze for the
  // page as a whole, but a native animated <img> keeps animating through
  // that, because the browser advances image animations off the main
  // thread. Our canvases could not: every repaint needed tick() to run. So
  // the script turned a barely-visible stall into a visible one — animated
  // emotes froze for the stall, then jumped.
  //
  // Now each canvas is transferred to a dedicated worker
  // (transferControlToOffscreen). The worker owns the decoded frames, the
  // shared per-emote clocks and its own requestAnimationFrame loop, and
  // commits frames straight to the compositor. Measured on twitch.tv with
  // the main thread deliberately blocked for 600ms: 87 worker frames drawn.
  // Positioning, occlusion and visibility stay on the main thread and still
  // pause with the page — as does the chat itself — but the animation no
  // longer does, which is exactly how a native image behaves.
  //
  // If a worker can't be created (CSP, missing OffscreenCanvas) everything
  // falls back to the main-thread renderer below, unchanged.
  let RENDER_WORKER = null;
  let nextInstanceId = 1;
  // Parked placeholders whose OffscreenCanvas + 2D context already live in the
  // worker. Creating a fresh accelerated 2D context for every attach and
  // destroying it on every detach thrashed the GPU process under fast chat
  // (measured: rAF starved for whole seconds at ~280 contexts/s). Reusing
  // them makes an attach a message, not an allocation. Bounded so an
  // unusually busy moment doesn't pin memory forever.
  const CANVAS_POOL = [];
  const CANVAS_POOL_MAX = 400;

  function workerSource() {
    // Helpers shared with the main thread are shipped by source, so the two
    // can never disagree about URL variants or frame durations.
    return [
      variantTable.toString(),
      'const VARIANTS = variantTable();',
      variantForPx.toString(),
      sanitizeFrameDuration.toString(),
      'const BITMAP_BUDGET_BYTES = ' + BITMAP_BUDGET_BYTES + ';',
      'const DECODE_CONCURRENCY = ' + DECODE_CONCURRENCY + ';',
      workerBody.toString(),
      'workerBody();',
    ].join('\n');
  }

  // Runs inside the worker. Written without template literals or closures
  // over the page so it survives Function.prototype.toString unchanged.
  function workerBody() {
    const states = new Map();      // key -> { frames, cumulative, totalDuration, startTime, ... , instances:Set }
    const instances = new Map();   // id  -> { ctx, canvas, key, w, h, visible, lastFrameIndex }
    const pendingGm = new Map();   // key -> { resolve, reject } for GM_xmlhttpRequest fallbacks
    let totalBytes = 0;
    let framesDrawn = 0;
    const fetched = [];
    const queue = [];
    let inFlight = 0;

    function post(m, t) { if (t) self.postMessage(m, t); else self.postMessage(m); }

    function fetchBuf(key, url) {
      fetched.push(url); if (fetched.length > 300) fetched.shift();
      return fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('bad status ' + r.status);
        const type = r.headers.get('content-type') || '';
        return r.arrayBuffer().then(function (buf) { return { buf: buf, type: type }; });
      }).catch(function () {
        // CORS-restricted CDN: ask the page to fetch it with GM_xmlhttpRequest.
        return new Promise(function (resolve, reject) {
          pendingGm.set(key, { resolve: resolve, reject: reject });
          post({ t: 'gmfetch', key: key, url: url });
        });
      });
    }

    function guessType(url, type) {
      if (type) return type;
      if (/\.avif(\?|$)/i.test(url)) return 'image/avif';
      if (/\.gif(\?|$)/i.test(url)) return 'image/gif';
      if (/\.png(\?|$)/i.test(url)) return 'image/png';
      return 'image/webp';
    }

    function freeFrames(st) {
      if (!st.frames) return;
      for (let i = 0; i < st.frames.length; i++) { const b = st.frames[i].bitmap; if (b.close) b.close(); }
      totalBytes -= st.bytes || 0;
      st.bytes = 0; st.frames = null; st.cumulative = null; st.fiNow = -1;
    }

    function enforceBudget() {
      if (totalBytes <= BITMAP_BUDGET_BYTES) return;
      const idle = [];
      states.forEach(function (st, key) { if (st.frames && st.instances.size === 0) idle.push([key, st]); });
      idle.sort(function (a, b) { return (a[1].lastUsed || 0) - (b[1].lastUsed || 0); });
      for (let i = 0; i < idle.length && totalBytes > BITMAP_BUDGET_BYTES; i++) {
        freeFrames(idle[i][1]);
        states.delete(idle[i][0]);
      }
    }

    function pump() {
      while (inFlight < DECODE_CONCURRENCY && queue.length) {
        const st = queue.shift();
        if (states.get(st.key) !== st) continue;
        inFlight++;
        decode(st).then(pump, pump);
      }
    }
    function enqueue(st) { queue.push(st); pump(); }

    async function decode(st) {
      try {
        if (typeof ImageDecoder === 'undefined') throw new Error('no ImageDecoder');
        const targetPx = Math.max(8, Math.round(st.targetPx || 32));
        const url = variantForPx(st.baseUrl, targetPx);
        const got = await fetchBuf(st.key, url);
        const decoder = new ImageDecoder({ data: got.buf, type: guessType(url, got.type) });
        await decoder.tracks.ready;
        const frameCount = (decoder.tracks.selectedTrack && decoder.tracks.selectedTrack.frameCount) || 1;
        if (frameCount <= 1) {
          st.staticOnly = true; st.loading = false;
          if (decoder.close) decoder.close();
          post({ t: 'status', key: st.key, status: 'static' });
          return;
        }
        const frames = [];
        let total = 0;
        for (let i = 0; i < frameCount; i++) {
          const res = await decoder.decode({ frameIndex: i });
          const image = res.image;
          const durationMs = sanitizeFrameDuration(image.duration);
          let bitmap;
          try { bitmap = await createImageBitmap(image); } finally { image.close(); }
          frames.push({ bitmap: bitmap, duration: durationMs });
          total += durationMs;
        }
        if (states.get(st.key) !== st) {
          for (let i = 0; i < frames.length; i++) if (frames[i].bitmap.close) frames[i].bitmap.close();
          return;
        }
        const old = st.frames, oldBytes = st.bytes || 0;
        st.frames = frames;
        st.decodedPx = targetPx;
        st.totalDuration = total > 0 ? total : frames.length * 100;
        const cum = new Float64Array(frames.length);
        let acc = 0;
        for (let i = 0; i < frames.length; i++) { acc += frames[i].duration; cum[i] = acc; }
        st.cumulative = cum;
        let bytes = 0;
        for (let i = 0; i < frames.length; i++) bytes += (frames[i].bitmap.width || 0) * (frames[i].bitmap.height || 0) * 4;
        st.bytes = bytes; totalBytes += bytes;
        if (old) { for (let i = 0; i < old.length; i++) if (old[i].bitmap.close) old[i].bitmap.close(); totalBytes -= oldBytes; }
        st.fiNow = -1;
        // The shared epoch is set exactly once, ever. A resolution upgrade
        // must never rewind it — that would restart every visible copy.
        if (!st.startTime) st.startTime = performance.now();
        st.loading = false;
        if (decoder.close) decoder.close();
        st.instances.forEach(function (inst) { applySize(inst, st); inst.lastFrameIndex = -1; });
        post({ t: 'status', key: st.key, status: 'ready' });
        enforceBudget();
      } catch (e) {
        if (!st.frames) { st.failed = true; post({ t: 'status', key: st.key, status: 'failed' }); }
        st.loading = false;
      } finally {
        st.upgrading = false;
        inFlight--;
      }
    }

    // Buffer = requested display size, capped at the decoded bitmap so it is
    // never an upscale. Re-run after every decode: an upgrade raises the cap.
    function applySize(inst, st) {
      if (!inst.reqW) return;
      let w = inst.reqW, h = inst.reqH;
      if (st && st.frames) { w = Math.min(w, st.frames[0].bitmap.width); h = Math.min(h, st.frames[0].bitmap.height); }
      w = Math.max(1, w); h = Math.max(1, h);
      if (w === inst.w && h === inst.h) return;
      inst.canvas.width = w; inst.canvas.height = h;
      inst.w = w; inst.h = h;
      inst.ctx.imageSmoothingEnabled = true;
      inst.ctx.imageSmoothingQuality = 'high';
      inst.lastFrameIndex = -1;
    }

    function getState(key, baseUrl, px) {
      let st = states.get(key);
      if (!st) {
        st = { key: key, baseUrl: baseUrl, frames: null, cumulative: null, totalDuration: 0, startTime: 0,
               loading: true, failed: false, staticOnly: false, bytes: 0, lastUsed: performance.now(),
               targetPx: px || 32, decodedPx: 0, upgrading: false, fiNow: -1, fiIndex: 0, instances: new Set() };
        states.set(key, st);
        enqueue(st);
      } else if (!st.frames && !st.loading && !st.failed && !st.staticOnly) {
        // Freed under memory pressure while off screen: decode again, and
        // tell the page so it doesn't hide the native <img> before we can draw.
        st.loading = true; st.targetPx = Math.max(st.targetPx || 0, px || 32);
        post({ t: 'status', key: key, status: 'loading' });
        enqueue(st);
      }
      return st;
    }

    function frameIndex(st, now) {
      if (st.fiNow === now) return st.fiIndex;
      const elapsed = (now - st.startTime) % st.totalDuration;
      const cum = st.cumulative;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (elapsed < cum[mid]) hi = mid; else lo = mid + 1; }
      st.fiNow = now; st.fiIndex = lo;
      return lo;
    }

    function loop() {
      const now = performance.now();
      states.forEach(function (st) {
        if (!st.frames || st.instances.size === 0) return;
        const fi = frameIndex(st, now);
        const frame = st.frames[fi].bitmap;
        st.instances.forEach(function (inst) {
          if (!inst.visible || !inst.ctx) return;
          if (fi === inst.lastFrameIndex) return;
          try {
            inst.ctx.clearRect(0, 0, inst.w, inst.h);
            inst.ctx.drawImage(frame, 0, 0, inst.w, inst.h);
            inst.lastFrameIndex = fi;
            framesDrawn++;
          } catch (e) {
            inst.visible = false;
            post({ t: 'drawError', id: inst.id });
          }
        });
        st.lastUsed = now;
      });
      self.requestAnimationFrame(loop);
    }
    self.requestAnimationFrame(loop);

    self.onmessage = function (e) {
      const m = e.data;
      if (m.t === 'attach') {
        const st = getState(m.key, m.url, m.px);
        const ctx = m.canvas.getContext('2d');
        const inst = { id: m.id, canvas: m.canvas, ctx: ctx, key: m.key, w: 1, h: 1, visible: false, lastFrameIndex: -1 };
        instances.set(m.id, inst);
        st.instances.add(inst);
        st.lastUsed = performance.now();
      } else if (m.t === 'detach') {
        const inst = instances.get(m.id);
        if (!inst) return;
        instances.delete(m.id);
        const st = states.get(inst.key);
        if (st) st.instances.delete(inst);
      } else if (m.t === 'park') {
        // Keep the canvas and context; just unbind it from its emote.
        const inst = instances.get(m.id);
        if (!inst) return;
        const st = states.get(inst.key);
        if (st) st.instances.delete(inst);
        inst.key = null; inst.visible = false; inst.lastFrameIndex = -1;
      } else if (m.t === 'reuse') {
        const inst = instances.get(m.id);
        if (!inst) return;
        const st = getState(m.key, m.url, m.px);
        inst.key = m.key; inst.visible = false; inst.lastFrameIndex = -1;
        st.instances.add(inst);
        st.lastUsed = performance.now();
        applySize(inst, st);
      } else if (m.t === 'size') {
        const inst = instances.get(m.id);
        if (!inst) return;
        inst.reqW = m.w; inst.reqH = m.h;
        applySize(inst, states.get(inst.key));
      } else if (m.t === 'vis') {
        const inst = instances.get(m.id);
        if (inst) { inst.visible = !!m.on; if (m.on) inst.lastFrameIndex = -1; }
      } else if (m.t === 'want') {
        const st = states.get(m.key);
        if (!st || st.upgrading || st.loading || !st.decodedPx) return;
        if (m.px > st.decodedPx * 1.25) { st.upgrading = true; st.targetPx = m.px; enqueue(st); }
      } else if (m.t === 'gmfetched') {
        const p = pendingGm.get(m.key); pendingGm.delete(m.key);
        if (p) p.resolve({ buf: m.buf, type: m.type || '' });
      } else if (m.t === 'gmfailed') {
        const p = pendingGm.get(m.key); pendingGm.delete(m.key);
        if (p) p.reject(new Error('GM fetch failed'));
      } else if (m.t === 'release') {
        const st = states.get(m.key);
        if (st && st.instances.size === 0) { freeFrames(st); states.delete(m.key); }
      } else if (m.t === 'stats') {
        let bytes = 0; states.forEach(function (st) { bytes += st.bytes || 0; });
        post({ t: 'stats', framesDrawn: framesDrawn, states: states.size, instances: instances.size, bitmapBytes: bytes, fetched: fetched.slice() });
      }
    };
  }

  function startRenderWorker() {
    try {
      if (typeof OffscreenCanvas === 'undefined' || !HTMLCanvasElement.prototype.transferControlToOffscreen) return null;
      const url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = onWorkerMessage;
      w.onerror = () => { /* keep going; instances simply won't draw until the fallback in tick hides them */ };
      return w;
    } catch (e) {
      return null;
    }
  }

  // Waiters for the worker's stats reply (diagnostics only).
  const statsWaiters = [];

  function onWorkerMessage(e) {
    const m = e.data;
    if (m.t === 'status') {
      const state = STATE_MAP.get(m.key);
      if (!state) return;
      if (m.status === 'ready') { state.frames = true; state.loading = false; state.failed = false; state.staticOnly = false; }
      else if (m.status === 'static') { state.staticOnly = true; state.loading = false; }
      else if (m.status === 'failed') { state.failed = true; state.loading = false; }
      else if (m.status === 'loading') { state.frames = null; state.loading = true; }
    } else if (m.t === 'drawError') {
      for (const inst of INSTANCES.values()) if (inst.id === m.id) { inst.drawFailed = true; break; }
    } else if (m.t === 'gmfetch') {
      if (typeof GM_xmlhttpRequest !== 'function') { RENDER_WORKER.postMessage({ t: 'gmfailed', key: m.key }); return; }
      GM_xmlhttpRequest({
        method: 'GET', url: m.url, responseType: 'arraybuffer',
        onload: (res) => {
          if (res.status < 200 || res.status >= 300 || !res.response) { RENDER_WORKER.postMessage({ t: 'gmfailed', key: m.key }); return; }
          const ct = (res.responseHeaders || '').match(/content-type:\s*([^\r\n;]+)/i);
          RENDER_WORKER.postMessage({ t: 'gmfetched', key: m.key, buf: res.response, type: ct ? ct[1].trim() : '' }, [res.response]);
        },
        onerror: () => RENDER_WORKER.postMessage({ t: 'gmfailed', key: m.key }),
      });
    } else if (m.t === 'stats') {
      while (statsWaiters.length) statsWaiters.shift()(m);
    }
  }
  const INSTANCES = new Map();   // <img> -> per-instance canvas/bookkeeping
  let overlayLayer = null;

  function ensureOverlayLayer() {
    if (overlayLayer && document.body.contains(overlayLayer)) return overlayLayer;
    overlayLayer = document.createElement('div');
    overlayLayer.id = 'tenr-overlay-layer';
    Object.assign(overlayLayer.style, {
      position: 'fixed', top: '0', left: '0', width: '0', height: '0',
      overflow: 'visible', pointerEvents: 'none',
      // Maximal z-index: occlusion/clip-path (below) is what decides
      // whether something should legitimately cover an emote (a Predict
      // panel, pinned banner, sticky header), so this no longer needs to
      // be conservative. A lower z-index here previously put our canvas
      // *underneath* Twitch's own hover-preview tooltip (itself a
      // high-z-index popover), leaving animated emotes blank in the
      // enlarged preview since the real <img> is hidden and our canvas
      // was invisible behind the tooltip's own background.
      zIndex: '2147483647',
    });
    // Diagnostics only: lets a test rig ask the worker what it drew/fetched.
    overlayLayer.__tenrStats = () => new Promise((resolve) => {
      if (!RENDER_WORKER) { resolve(null); return; }
      statsWaiters.push(resolve);
      RENDER_WORKER.postMessage({ t: 'stats' });
    });
    document.body.appendChild(overlayLayer);
    return overlayLayer;
  }

  // ---- Emote URL parsing ----------------------------------------------

  const keyForUrl = (url) => {
    for (const { name, re } of URL_PATTERNS) {
      const m = url.match(re);
      if (m) return `${name}:${m[1]}`;
    }
    return null;
  };

  const isCandidateUrl = (url) => !!url && URL_PATTERNS.some(({ re }) => re.test(url));

  function bestUrlFor(imgEl) {
    // Read the srcset/src *attributes* first — they change synchronously
    // with the DOM mutation that fires our MutationObserver. imgEl.currentSrc
    // is the browser's own async-resolved "which responsive candidate did I
    // pick" property and can lag a frame behind on a recycled <img> node,
    // which previously caused a stale key: our canvas kept showing an old
    // emote's animation while Twitch's own tooltip (reading attributes
    // directly) correctly reported the new emote's real name.
    const srcset = imgEl.getAttribute('srcset');
    if (srcset) {
      const candidates = srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(isCandidateUrl);
      if (candidates.length) return candidates[candidates.length - 1];
    }
    const srcAttr = imgEl.getAttribute('src');
    if (isCandidateUrl(srcAttr)) return srcAttr;
    if (isCandidateUrl(imgEl.currentSrc)) return imgEl.currentSrc;
    if (isCandidateUrl(imgEl.src)) return imgEl.src;
    return null;
  }

  function liveKeyFor(imgEl) {
    const url = bestUrlFor(imgEl);
    return url ? keyForUrl(url) : null;
  }

  function guessMimeType(url) {
    // 7TV 1.10+ serves AVIF by default (its own setting defaults to AVIF and
    // only falls back to WEBP where AVIF is unsupported), so an emote URL
    // ending .avif is the common case now, not an exotic one. Only reached
    // when the response carries no content-type - i.e. the GM_xmlhttpRequest
    // fallback - but mislabelling an AVIF buffer as WebP fails the decode
    // outright, which silently drops the emote back to the unsynced <img>.
    if (/\.avif(\?|$)/i.test(url)) return 'image/avif';
    if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
    if (/\.gif(\?|$)/i.test(url)) return 'image/gif';
    if (/\.png(\?|$)/i.test(url)) return 'image/png';
    return 'image/webp';
  }

  // Every instance of an emote shares one decode, so always fetch the
  // largest known size variant for its provider — otherwise whichever
  // <img> happens to trigger the decode first (often a small inline chat
  // image) would leave every other instance, including Twitch's own
  // enlarged hover preview, stuck showing an upscaled/blurry bitmap.
  // v2.5.2: pick the SMALLEST published variant that still covers the height
  // the emote is actually drawn at, instead of always taking the largest.
  //
  // Always decoding the largest was affordable for Twitch emotes (7 frames)
  // but not for 7TV: a 66-frame emote at 4x is ~4.1MB of ImageBitmaps, so the
  // v2.5.1 memory ceiling only held ~46 distinct animated emotes. A live 7TV
  // channel cycles through far more than that, so emotes were being evicted
  // and re-decoded constantly — and each re-decode drops back to the native
  // <img> and then snaps to the shared clock. That is the "already-seen emote
  // lags then fixes itself" report. At 2x the same budget holds ~186.
  //
  // Sizes below are each provider's nominal variant HEIGHT; chat renders
  // emotes at a fixed height with width auto, so height is the constraint.
  function variantTable() {
  return [
    [/^(https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[^/]+\/[^/]+\/[^/]+\/)[\d.]+$/,
     [['1.0', 28], ['2.0', 56], ['3.0', 112]], ''],
    [/^(https:\/\/cdn\.7tv\.(?:app|io)\/emote\/[^/]+\/)\d+x(\.\w+)?$/,
     [['1x', 32], ['2x', 64], ['3x', 96], ['4x', 128]], ''],
    [/^(https:\/\/cdn\.betterttv\.net\/emote\/[^/]+\/)\d+x(\.\w+)?$/,
     [['1x', 28], ['2x', 56], ['3x', 112]], ''],
    // FFZ's animated emotes sit under an extra "/animated/" segment; the
    // plain pattern below only matches static-layout URLs.
    [/^(https:\/\/cdn\.frankerfacez\.com\/(?:emote|emoticon)\/[^/]+\/animated\/)\d+(\.\w+)?$/,
     [['1', 32], ['2', 64], ['4', 128]], '.webp'],
    [/^(https:\/\/cdn\.frankerfacez\.com\/(?:emote|emoticon)\/[^/]+\/)\d+(\.\w+)?$/,
     [['1', 32], ['2', 64], ['4', 128]], ''],
  ];
  }
  const VARIANTS = variantTable();

  function variantForPx(url, px) {
    // Strip any #fragment / ?query before matching, then put it back. Twitch
    // appends "#e=0" to emote URLs, which defeats every $-anchored pattern.
    const tail = url.match(/[?#].*$/);
    if (tail) return variantForPx(url.slice(0, tail.index), px) + tail[0];
    for (const [re, sizes, defExt] of VARIANTS) {
      const m = url.match(re);
      if (!m) continue;
      let chosen = sizes[sizes.length - 1][0];
      for (const [suffix, h] of sizes) { if (h >= px) { chosen = suffix; break; } }
      return m[1] + chosen + (m[2] || defExt);
    }
    return url;
  }

  // Height a freshly-seen emote is decoded at before anything has measured it.
  // Chat emotes are ~28 CSS px; tick() upgrades on demand if a bigger instance
  // (Twitch's enlarged hover preview) shows up.
  const defaultDecodePx = () => Math.ceil(28 * (window.devicePixelRatio || 1));

  // ---- Fetch + decode ---------------------------------------------------

  function fetchArrayBuffer(url) {
    return fetch(url, { mode: 'cors', credentials: 'omit' })
      .then((resp) => {
        if (!resp.ok) throw new Error('bad status ' + resp.status);
        const type = resp.headers.get('content-type') || guessMimeType(url);
        return resp.arrayBuffer().then((buf) => ({ buf, type }));
      })
      .catch(() => {
        // Some CDNs don't send permissive CORS headers to a plain fetch;
        // GM_xmlhttpRequest is exempt from that, so fall back to it.
        if (typeof GM_xmlhttpRequest !== 'function') throw new Error('no GM fallback');
        return new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url, responseType: 'arraybuffer',
            onload: (res) => {
              if (res.status < 200 || res.status >= 300) return reject(new Error('GM status ' + res.status));
              const ct = (res.responseHeaders || '').match(/content-type:\s*([^\r\n;]+)/i);
              resolve({ buf: res.response, type: ct ? ct[1].trim() : guessMimeType(url) });
            },
            onerror: reject,
          });
        });
      });
  }

  // A burst of unseen emotes used to start an unbounded number of concurrent
  // decodes, each awaiting ImageDecoder.decode() + createImageBitmap() per
  // frame on the main thread. Two at a time keeps a burst from competing with
  // the render loop; the queue drains in arrival order.
  const DECODE_CONCURRENCY = 2;
  const decodeQueue = [];
  let decodesInFlight = 0;

  function pumpDecodeQueue() {
    while (decodesInFlight < DECODE_CONCURRENCY && decodeQueue.length) {
      const state = decodeQueue.shift();
      // Dropped while queued (every instance disappeared) — skip it.
      if (STATE_MAP.get(state.key) !== state) continue;
      decodesInFlight++;
      decodeInto(state).then(pumpDecodeQueue, pumpDecodeQueue);
    }
  }

  function enqueueDecode(state) {
    decodeQueue.push(state);
    pumpDecodeQueue();
  }

  function createState(key, url) {
    const state = {
      key, url, baseUrl: url, frames: null, totalDuration: 0, startTime: 0,
      loading: true, failed: false, staticOnly: false, cleanupTimer: null,
      cumulative: null, fiNow: -1, fiIndex: 0,
      bytes: 0, lastUsed: performance.now(),
      // v2.5.2 resolution bookkeeping: targetPx is what the in-flight decode
      // is fetching, decodedPx what the current frames actually are, wantPx
      // the largest height any live instance needs this frame.
      targetPx: defaultDecodePx(), decodedPx: 0, wantPx: 0, wantFrame: -1,
      upgrading: false,
    };
    STATE_MAP.set(key, state);
    // In worker mode the worker decodes on its first 'attach' for this key;
    // the page just mirrors its status (see onWorkerMessage).
    if (!RENDER_WORKER) enqueueDecode(state);
    return state;
  }

  // v2.4.1: a few emotes come back from ImageDecoder with image.duration
  // of 0/undefined/NaN on some or all frames. Those collapsed
  // totalDuration, so currentFrameIndex() swept the whole animation in a
  // few milliseconds and the emote looked like it was vibrating between a
  // couple of frames. Browsers apply the same kind of floor to their own
  // native GIF playback, so this doesn't change how a well-formed emote
  // plays back — it only rescues malformed ones.
  function sanitizeFrameDuration(rawMicroseconds) {
    let ms = rawMicroseconds ? rawMicroseconds / 1000 : 100;
    if (!isFinite(ms) || ms <= 0) ms = 100;
    if (ms < 10) ms = 10;
    return ms;
  }

  async function decodeInto(state) {
    try {
      if (typeof ImageDecoder === 'undefined') {
        state.failed = true; state.loading = false; return;
      }
      const targetPx = Math.max(8, Math.round(state.targetPx || defaultDecodePx()));
      const { buf, type } = await fetchArrayBuffer(variantForPx(state.baseUrl, targetPx));
      const decoder = new ImageDecoder({ data: buf, type });
      await decoder.tracks.ready;
      const frameCount = (decoder.tracks.selectedTrack && decoder.tracks.selectedTrack.frameCount) || 1;

      if (frameCount <= 1) {
        state.staticOnly = true; state.loading = false;
        if (decoder.close) decoder.close();
        return;
      }

      const frames = [];
      let total = 0;
      for (let i = 0; i < frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        const durationMs = sanitizeFrameDuration(image.duration);
        // VideoFrame -> ImageBitmap avoids the pink/white diagonal
        // corruption some animated WebP/GIFs show when a raw WebCodecs
        // VideoFrame is drawn straight onto a 2D canvas.
        let bitmap;
        try { bitmap = await createImageBitmap(image); } finally { image.close(); }
        frames.push({ bitmap, duration: durationMs });
        total += durationMs;
      }

      // If every instance disappeared (and cleanup deleted this state)
      // while we were mid-decode, don't resurrect it.
      if (STATE_MAP.get(state.key) !== state) {
        frames.forEach((f) => f.bitmap.close && f.bitmap.close());
        return;
      }
      // An upgrade replaces the frames of a state that is already on screen.
      // Swap them in first, then release the old ones, so there is never a
      // frame where the emote has nothing to draw.
      const oldFrames = state.frames, oldBytes = state.bytes || 0;
      state.frames = frames;
      state.decodedPx = targetPx;
      state.totalDuration = total > 0 ? total : frames.length * 100;
      // Prefix sums of frame durations, so currentFrameIndex() can binary
      // search instead of walking the list.
      const cum = new Float64Array(frames.length);
      let acc = 0;
      for (let i = 0; i < frames.length; i++) { acc += frames[i].duration; cum[i] = acc; }
      state.cumulative = cum;
      let bytes = 0;
      for (const f of frames) bytes += (f.bitmap.width || 0) * (f.bitmap.height || 0) * 4;
      state.bytes = bytes;
      totalBitmapBytes += bytes;
      if (oldFrames) {
        oldFrames.forEach((f) => f.bitmap.close && f.bitmap.close());
        totalBitmapBytes -= oldBytes;
      }
      state.fiNow = -1; // frame-index memo refers to the old frame list
      // The shared epoch is set exactly once, EVER. A resolution upgrade must
      // not touch it: rewinding it here would restart every on-screen copy,
      // which is precisely the bug this script exists to prevent.
      if (!state.startTime) state.startTime = performance.now();
      state.loading = false;
      if (decoder.close) decoder.close();
      enforceBitmapBudget();
    } catch (e) {
      // An upgrade that fails leaves the existing frames in place and simply
      // keeps playing at the lower resolution; only a first decode is fatal.
      if (!state.frames) state.failed = true;
      state.loading = false;
    } finally {
      state.upgrading = false;
      decodesInFlight--;
    }
  }

  // Reuses an existing shared state untouched if one already exists for
  // this key. This is the actual fix for the reported bug: it never
  // re-decodes and never resets startTime, so adding a new on-screen copy
  // of an emote cannot rewind any existing copy's animation.
  function acquireState(key, url) {
    let state = STATE_MAP.get(key);
    // Dropped under memory pressure while off screen — decode it again.
    if (!RENDER_WORKER && state && !state.frames && !state.loading && !state.failed && !state.staticOnly) {
      state.loading = true;
      state.targetPx = Math.max(state.targetPx || 0, defaultDecodePx());
      enqueueDecode(state);
    }
    if (!state) state = createState(key, url);
    state.lastUsed = performance.now();
    if (state.cleanupTimer) { clearTimeout(state.cleanupTimer); state.cleanupTimer = null; }
    return state;
  }

  // Lifecycle is derived by scanning INSTANCES at cleanup time, not by a
  // refcount. A refcount is vulnerable to drift — any path that releases
  // without a matching acquire eventually hits 0 while instances are
  // still attached, deleting the state early; the next attach then
  // creates a *new* state with a fresh startTime, which resets every
  // still-visible copy back to frame 0. That's indistinguishable from the
  // original bug this script exists to fix, so it isn't worth risking.
  function freeStateFrames(state) {
    if (!state.frames) return;
    if (Array.isArray(state.frames)) state.frames.forEach((f) => f.bitmap.close && f.bitmap.close());
    totalBitmapBytes -= state.bytes || 0;
    state.bytes = 0;
    state.frames = null;
    state.cumulative = null;
    state.fiNow = -1;
    // Not marked failed: if it comes back on screen it simply decodes again.
    state.loading = false;
  }

  // Free decoded emotes that currently have NO instance on screen, oldest use
  // first, until back under budget. An emote that is still displayed is never
  // touched — dropping its frames would restart its animation, which is the
  // exact bug this script exists to prevent.
  function enforceBitmapBudget() {
    if (totalBitmapBytes <= BITMAP_BUDGET_BYTES) return;
    const inUse = new Set();
    for (const inst of INSTANCES.values()) inUse.add(inst.key);
    const idle = [];
    for (const [key, st] of STATE_MAP) {
      if (st.frames && !inUse.has(key)) idle.push([key, st]);
    }
    idle.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    for (const [key, st] of idle) {
      if (totalBitmapBytes <= BITMAP_BUDGET_BYTES) break;
      if (st.cleanupTimer) { clearTimeout(st.cleanupTimer); st.cleanupTimer = null; }
      freeStateFrames(st);
      STATE_MAP.delete(key);
    }
  }

  function releaseState(key) {
    const state = STATE_MAP.get(key);
    if (!state) return;
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = setTimeout(() => {
      state.cleanupTimer = null;
      if (STATE_MAP.get(key) !== state) return;
      for (const inst of INSTANCES.values()) {
        if (inst.key === key) return; // still in use — leave it alone
      }
      if (RENDER_WORKER) RENDER_WORKER.postMessage({ t: 'release', key });
      freeStateFrames(state);
      STATE_MAP.delete(key);
    }, CLEANUP_DELAY_MS);
  }

  // ---- Instance attach/detach -------------------------------------------
  //
  // Deliberately NOT scoped to "chat messages only" via DOM selectors. An
  // earlier version tried to allowlist chat containers by guessing at
  // Twitch's attribute/class names, and that allowlist silently broke
  // whenever a message's actual markup didn't match the guess — the exact
  // "some emotes just don't show anymore" bug. Any matching emote image
  // (chat, hover preview, emote picker) gets the same safe treatment, so
  // there's nothing to get wrong here; the cost is a few extra decodes if
  // a picker is opened, which is bounded and self-cleans after 15s idle.

  function attachInstance(imgEl) {
    if (INSTANCES.has(imgEl)) return;
    const url = bestUrlFor(imgEl);
    const key = url && keyForUrl(url);
    if (!key) return;

    let canvas, ctx = null, offscreen = null, pooledId = 0;
    const parked = RENDER_WORKER ? CANVAS_POOL.pop() : null;
    if (parked) {
      canvas = parked.canvas;
      pooledId = parked.id;
      canvas.removeAttribute('data-parked');
      canvas.style.clipPath = '';
      canvas.style.transform = '';
    } else {
      canvas = document.createElement('canvas');
      canvas.className = 'tenr-canvas';
      // A canvas defaults to 300x150, and getContext() below commits that buffer
      // (180KB) immediately — for every instance, before it has drawn anything.
      // During a burst of new emotes that is a lot of memory held by canvases
      // that are still waiting on a decode. Start at 1x1; the draw path sizes it.
      canvas.width = 1;
      canvas.height = 1;
      Object.assign(canvas.style, { position: 'fixed', top: '0', left: '0', pointerEvents: 'none', display: 'none' });
      if (RENDER_WORKER) {
        // Ownership of the pixel buffer moves to the worker; from here on the
        // page only positions, clips and shows/hides the placeholder.
        offscreen = canvas.transferControlToOffscreen();
      } else {
        ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
      }
      ensureOverlayLayer().appendChild(canvas);
    }

    // occlusionInsets: undefined = not yet computed (computed in the next
    // tick's read phase, before the next paint); null = fully occluded
    // (hide); {top,bottom} = partial crop.
    const inst = {
      canvas, ctx, key, hidden: false,
      clipAncestor: undefined, rowRoot: undefined,
      occlusionInsets: undefined,
      lastOcclusionRect: null,
      lastSampleAt: -Infinity,
      bmpW: 1, bmpH: 1,
      lastFrameIndex: -1,
      lastSrcset: imgEl.getAttribute('srcset'), lastSrc: imgEl.getAttribute('src'),
      // worker mode
      id: pooledId || (RENDER_WORKER ? nextInstanceId++ : 0), visible: false, drawFailed: false,
    };
    INSTANCES.set(imgEl, inst);
    if (RENDER_WORKER) {
      if (pooledId) RENDER_WORKER.postMessage({ t: 'reuse', id: inst.id, key, url, px: defaultDecodePx() });
      else RENDER_WORKER.postMessage({ t: 'attach', id: inst.id, canvas: offscreen, key, url, px: defaultDecodePx() }, [offscreen]);
    }

    // acquireState returns the *existing* shared state untouched when this
    // emote is already on screen, which is what preserves the clock.
    // `url` is the largest srcset candidate; the state rewrites it to the
    // variant it actually needs (see variantForPx).
    const state = acquireState(key, url);

    // v2.4.2: no synchronous occlusion check here any more. It forced a
    // layout inside the MutationObserver callback, interleaved with the
    // DOM writes above, once per attached emote (layout thrashing during
    // a burst). It also never made the canvas show up sooner: drawing only
    // happens in tick(), which runs before the next paint and computes
    // this instance's occlusion in its read-only phase.

    // v2.4.0: if the shared state is already decoded, hide the native
    // <img> *now*, in the same task as the DOM insertion, so a repeat
    // instance never shows Twitch's own native animation (starting at its
    // own frame 0) before our canvas draws it on the shared clock.
    if (state.frames && !state.loading && !state.failed && !state.staticOnly) {
      imgEl.style.opacity = '0';
      inst.hidden = true;
    }
  }

  function detachInstance(imgEl) {
    const inst = INSTANCES.get(imgEl);
    if (!inst) return;
    if (RENDER_WORKER && !inst.drawFailed && CANVAS_POOL.length < CANVAS_POOL_MAX) {
      // Park it: the worker keeps the context, the page keeps the element hidden.
      RENDER_WORKER.postMessage({ t: 'park', id: inst.id });
      inst.canvas.style.display = 'none';
      inst.canvas.setAttribute('data-parked', '');
      CANVAS_POOL.push({ canvas: inst.canvas, id: inst.id });
    } else {
      if (RENDER_WORKER) RENDER_WORKER.postMessage({ t: 'detach', id: inst.id });
      inst.canvas.remove();
    }
    INSTANCES.delete(imgEl);
    releaseState(inst.key);
    if (inst.hidden) imgEl.style.opacity = '';
  }

  // Nearest genuinely-scrollable ancestor (the chat message list). Only
  // overflowY auto/scroll counts — plain overflow:hidden is common for
  // unrelated reasons (text truncation, rounded corners) and would grab
  // some small inner wrapper, clipping emotes down to it.
  function findScrollClipAncestor(el) {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.clientHeight >= 120) return node;
      node = node.parentElement;
    }
    return null;
  }

  // The top-level child of clipAncestor that contains imgEl — i.e. "this
  // chat message's own DOM subtree". Anything Twitch draws inside it (a
  // hover highlight, reply button, badges) is not occlusion; anything
  // outside it (a Predict panel, pinned banner, sticky header) is.
  function findRowRoot(imgEl, clipAncestor) {
    if (!clipAncestor) return null;
    let node = imgEl;
    while (node.parentElement && node.parentElement !== clipAncestor) node = node.parentElement;
    return node.parentElement === clipAncestor ? node : null;
  }

  // v2.4.2: set of every instance's rowRoot, rebuilt each occlusion sweep.
  // A DOM change entirely inside one of these can't introduce a foreign
  // cover (by definition, everything inside a rowRoot counts as "visible"
  // to the occlusion test) — it can only move rows, which the per-emote
  // move check already catches. Used to avoid forcing FULL re-samples on
  // every new chat message.
  let knownRowRoots = new Set();
  // v2.5.0: the scroll containers those rows live in, tracked for the same
  // reason (see mutationMayChangeLayering).
  let knownClipAncestors = new Set();
  function isInsideKnownRow(node) {
    for (const root of knownRowRoots) {
      if (root === node || root.contains(node)) return true;
    }
    return false;
  }
  function isInsideKnownClip(node) {
    for (const clip of knownClipAncestors) {
      if (clip === node || clip.contains(node)) return true;
    }
    return false;
  }

  // ---- DOM scanning ------------------------------------------------------

  function maybeAttach(imgEl) {
    const url = bestUrlFor(imgEl);
    if (url && keyForUrl(url)) attachInstance(imgEl);
  }

  function scanNode(node) {
    if (!(node instanceof Element)) return;
    if (node === overlayLayer) return;
    if (node.tagName === 'IMG') maybeAttach(node);
    if (node.querySelectorAll) node.querySelectorAll('img').forEach(maybeAttach);
  }

  // v2.4.2: look up only the <img>s inside the removed subtree, instead of
  // testing every tracked instance with contains() for every removed node.
  function detachRemoved(node) {
    if (!(node instanceof Element) || node === overlayLayer || INSTANCES.size === 0) return;
    const imgs = node.tagName === 'IMG' ? [node] : Array.from(node.getElementsByTagName('img'));
    for (const img of imgs) {
      if (!INSTANCES.has(img)) continue;
      detachInstance(img);
      // Moved rather than removed (removed + re-inserted in the same
      // batch): re-attach so clipAncestor/rowRoot are recomputed for its
      // new position. The shared state (and its clock) is reused as-is.
      if (img.isConnected) maybeAttach(img);
    }
  }

  function hasElementNode(nodeList) {
    for (let i = 0; i < nodeList.length; i++) if (nodeList[i].nodeType === 1) return true;
    return false;
  }

  // Could this mutation have put something new on top of (or taken
  // something off of) an emote without the emote itself moving? Only
  // element additions/removals outside the chat rows can. src/srcset
  // attribute swaps and text-node churn can't change layering.
  function mutationMayChangeLayering(m) {
    if (m.type !== 'childList') return false;
    if (!hasElementNode(m.addedNodes) && !hasElementNode(m.removedNodes)) return false;
    // v2.5.0: THE fast-chat fix. v2.4.2 meant to stop new chat messages from
    // forcing a full occlusion re-sample, but it only excluded mutations
    // whose target was INSIDE a row. A new message is appended to the row
    // *list*, so the mutation target is the scroll container itself, which is
    // outside every rowRoot -- every single message still marked the sweep
    // dirty. Measured on a 20 msg/s harness: ~7900 forced elementFromPoint
    // hit-tests per second, all inside the rAF callback.
    //
    // Adding or evicting a row can only MOVE existing emotes; it cannot put a
    // foreign cover over one. Movement is already caught per-emote, every
    // frame, by the rect comparison in updateOcclusion().
    if (knownClipAncestors.has(m.target)) return false;
    return !isInsideKnownRow(m.target);
  }

  function startObserving() {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        // v2.4.2: our own canvases being appended to / removed from the
        // overlay layer are not page changes — ignore them entirely.
        // Previously every attach re-triggered this observer and marked
        // the occlusion sweep dirty.
        if (m.target === overlayLayer) continue;

        if (!occlusionDirty && mutationMayChangeLayering(m)) markOcclusionDirty();

        if (m.type === 'childList') {
          m.addedNodes.forEach(scanNode);
          m.addedNodes.forEach(considerForOverlay);
          m.removedNodes.forEach(detachRemoved);
        } else if (m.type === 'attributes' && m.target instanceof HTMLImageElement) {
          const imgEl = m.target;
          const existing = INSTANCES.get(imgEl);
          const newKey = liveKeyFor(imgEl);
          // Only tear down/rebuild when src/srcset resolves to a
          // *different, recognized* emote key. Third-party extensions
          // commonly rewrite src/srcset to blob:/data: URLs once they've
          // cached a decoded emote client-side; that doesn't match our
          // CDN patterns, so newKey comes back null even though the emote
          // itself hasn't changed. Treating "unrecognized" as "detach" was
          // tearing down already-synced, already-animating instances for
          // no reason — our canvas already sits on top of the native
          // <img>, so what its src points to afterward doesn't matter.
          if (newKey && existing && existing.key !== newKey) { detachInstance(imgEl); attachInstance(imgEl); }
          else if (newKey && !existing) attachInstance(imgEl);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  }

  // ---- Shared animation clock ---------------------------------------------

  // Every on-screen copy of an emote shares one clock, so the frame index is
  // identical for all of them -- but it used to be recomputed, with a linear
  // scan over the frame list, once per copy per frame. A 60-frame emote with
  // 100 copies on screen was ~6000 iterations per frame for a single value.
  // Memoized per state per tick, over precomputed cumulative offsets.
  function currentFrameIndex(state, now) {
    if (state.fiNow === now) return state.fiIndex;
    const elapsed = (now - state.startTime) % state.totalDuration;
    const cum = state.cumulative;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (elapsed < cum[mid]) hi = mid; else lo = mid + 1;
    }
    state.fiNow = now;
    state.fiIndex = lo;
    return lo;
  }

  // ---- Pointer-events-aware overlay candidates ----------------------------
  //
  // document.elementFromPoint() honours pointer-events, so a pinned banner
  // (or its wrapper) that sets pointer-events: none is completely invisible
  // to the occlusion test below — the sample point falls through to the
  // chat row underneath, `boundary.contains(hit)` returns true, and the
  // canvas draws straight over the banner. This scan collects those
  // overlays so they can be ORed into the sample test.
  //
  // v2.4.2: the scan used to walk the whole page (getComputedStyle on
  // thousands of elements) inside one frame, once a second — a visible
  // hitch in fast chat. It now walks a snapshot of the page a slice at a
  // time, at most OVERLAY_SCAN_BUDGET_MS per frame, and swaps the result
  // in when complete. Same filters, same result.

  let overlayCandidates = [];
  // Superset of overlayCandidates: everything that could *geometrically* sit
  // over an emote, whether or not elementFromPoint can see it. Used only to
  // decide whether an emote needs hit-testing at all.
  let coverZoneEls = [];
  let lastOverlayScan = -Infinity;
  let scanList = null;
  let scanIndex = 0;
  let scanOut = null;
  let scanZones = null;
  // v2.5.0: subtrees added to the page since the last check, awaiting a
  // candidacy test. Anything that becomes a cover has to enter the DOM (or be
  // restyled) first, so watching additions replaces almost all of the polling.
  let overlayPendingNodes = [];
  let lastOverlayRevalidate = -Infinity;

  // v2.4.1: an element can only *cover* an emote if it actually paints
  // something. Twitch mounts several full-viewport, fixed,
  // pointer-events:none containers that are pure layout scaffolding for
  // tooltips/toasts/drag previews; they paint nothing, but geometrically
  // they sit over every emote on screen.
  function paintsSomething(cs) {
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const bg = cs.backgroundColor;
    if (!bg || bg === 'transparent') return false;
    const m = bg.match(/^rgba?\(([^)]+)\)/i);
    if (!m) return false;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    const alpha = parts.length >= 4 ? parts[3] : 1;
    return isFinite(alpha) && alpha > 0.05;
  }

  // v2.5.0: the superset used for the cheap pre-test below. Only an
  // out-of-flow element that actually paints can cover an emote; in-flow
  // content above or below the chat simply doesn't overlap it, and clipping
  // by the scroll container is already handled geometrically in
  // computeClipPath() via cRect -- that never needed a hit-test.
  // v2.5.4: does this element, or anything inside it, actually paint? Measured
  // on twitch.tv: the pinned message is a painted position:relative card
  // sitting inside a TRANSPARENT position:absolute wrapper that overlays the
  // scroller. No single element there is both out-of-flow and painted, so
  // testing paint on the positioned element itself (v2.5.0–v2.5.3) never
  // admitted it as a cover — the emote drew unclipped over the card until the
  // 200ms full sweep's real hit-test corrected it. Bounded walk: covers are
  // small; the cap only matters for pathological wrappers.
  function hasPaintedDescendant(el) {
    if (paintsSomething(getComputedStyle(el))) return true;
    const kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
    for (let i = 0; i < kids.length && i < 200; i++) {
      const k = kids[i];
      const r = k.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (paintsSomething(getComputedStyle(k))) return true;
    }
    return false;
  }

  // Only a rect that overlaps a tracked chat scroller can cover an emote, so
  // page chrome elsewhere never occupies a COVER_ZONE_MAX slot. With no
  // instances yet there is nothing to compare against — accept, and let the
  // next refresh prune.
  function overlapsAnyKnownClip(r) {
    if (!knownClipAncestors.size) return true;
    for (const clip of knownClipAncestors) {
      if (!clip.isConnected) continue;
      const c = clip.getBoundingClientRect();
      if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) return true;
    }
    return false;
  }

  function isCoverZone(el) {
    if (el === overlayLayer || (overlayLayer && el.parentElement === overlayLayer)) return false;
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    const pos = cs.position;
    if (pos !== 'fixed' && pos !== 'sticky' && pos !== 'absolute') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    // v2.5.3: an absolutely-positioned element inside the chat scroller scrolls
    // WITH the messages — it travels alongside the emotes rather than covering
    // them, and chat markup is full of them (badges, 7TV overlays). Letting
    // those in would flood COVER_ZONE_MAX and crowd out the real cover.
    // A sticky or fixed element inside the scroller is the opposite: it stays
    // put while rows scroll under it.
    if (pos === 'absolute' && isInsideKnownClip(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (!overlapsAnyKnownClip(r)) return false;
    // v2.5.4: painted CONTENT, not a painted element. Verified live: of 21
    // out-of-flow candidates over the chat scroller this admits exactly the
    // pinned-message wrapper and rejects Twitch's full-column transparent
    // celebration overlay — which, admitted, would force a hit-test on every
    // emote every frame.
    return hasPaintedDescendant(el);
  }

  function isOverlayCandidate(el) {
    // v2.4.1: never our own overlay layer or its canvases (self-occlusion).
    if (el === overlayLayer || (overlayLayer && el.parentElement === overlayLayer)) return false;
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    // Only out-of-flow overlays: anything static that overlaps is already
    // reported by elementFromPoint.
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    // pointer-events:auto elements are already visible to elementFromPoint.
    if (cs.pointerEvents !== 'none') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    // A transparent wrapper can't visually cover anything.
    return paintsSomething(cs);
  }

  function sameElementList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Queue a newly-added subtree for a candidacy test. Called from the
  // MutationObserver. Chat churn is filtered out here rather than in the
  // scan: a node added inside a tracked chat row or scroll container cannot
  // be a page-level cover, and in fast chat that is essentially every
  // mutation. This is what removed the ~6700 getComputedStyle calls/second
  // the old page-wide poll was doing.
  function considerForOverlay(node) {
    if (!DETECT_POINTER_EVENTS_OVERLAYS) return;
    if (!(node instanceof Element)) return;
    if (node === overlayLayer || (overlayLayer && overlayLayer.contains(node))) return;
    // v2.5.3: no location filter here any more. v2.5.0 skipped anything inside
    // a known row or clip ancestor as a cheap way to avoid walking chat rows —
    // but on Twitch rowRoot is the WHOLE message-list wrapper, so that
    // excluded the entire chat column, and the pinned message lives inside it.
    // It therefore never became a cover: intersectsAnyCover() returned false,
    // the emote was drawn unclipped, and only the 200ms full sweep's real
    // hit-test corrected it — the "paints over the pinned message for a split
    // second" report. isCoverZone() now does the filtering, by position.
    if (overlayPendingNodes.length < 256) overlayPendingNodes.push(node);
  }

  // Re-test the current candidate list and fold in anything newly added.
  // Candidates are few (a pinned banner, a sticky header), so this is cheap
  // next to the old whole-document walk.
  function refreshOverlayCandidates() {
    const out = [];
    const zones = [];
    const seen = new Set();
    const consider = (el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (!isCoverZone(el)) return;
      if (zones.length < COVER_ZONE_MAX) zones.push(el);
      if (isOverlayCandidate(el)) out.push(el);
    };
    for (const el of coverZoneEls) if (el.isConnected) consider(el);
    for (const el of overlayCandidates) if (el.isConnected) consider(el);
    for (const node of overlayPendingNodes) {
      if (!node.isConnected) continue;
      consider(node);
      // A banner usually mounts as a wrapper whose positioned child is the
      // thing that actually paints, so look inside too — bounded, because
      // chat subtrees never reach here.
      const kids = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (let i = 0; i < kids.length && i < 2000; i++) consider(kids[i]);
    }
    overlayPendingNodes.length = 0;
    if (!sameElementList(overlayCandidates, out)) markOcclusionDirty();
    if (!sameElementList(coverZoneEls, zones)) markOcclusionDirty();
    overlayCandidates = out;
    coverZoneEls = zones;
  }

  function stepOverlayScan(now) {
    if (!DETECT_POINTER_EVENTS_OVERLAYS) return;

    // Fold in whatever the observer queued since the last frame. New nodes
    // are handled immediately (a banner must show up the frame it mounts).
    if (!scanList && overlayPendingNodes.length) {
      lastOverlayRevalidate = now;
      refreshOverlayCandidates();
      return;
    }

    // Safety net only: a cover can also appear without a DOM addition (a
    // class flip restyling an element to position:fixed). Rare, so this now
    // runs every OVERLAY_SCAN_MS instead of continuously.
    if (!scanList) {
      if (now - lastOverlayScan < OVERLAY_SCAN_MS) {
        // Existing candidates still need re-testing, for a cover that gets
        // hidden or restyled without any DOM change. That is a handful of
        // elements, but it is a getComputedStyle each -- throttled, because
        // running it every frame cost ~1300 getComputedStyle calls/second.
        if (coverZoneEls.length && now - lastOverlayRevalidate >= OVERLAY_REVALIDATE_MS) {
          lastOverlayRevalidate = now;
          refreshOverlayCandidates();
        }
        return;
      }
      scanList = document.body.querySelectorAll('*'); // static snapshot
      scanIndex = 0;
      scanOut = [];
      scanZones = [];
    }
    const deadline = performance.now() + OVERLAY_SCAN_BUDGET_MS;
    const len = scanList.length;
    while (scanIndex < len) {
      if ((scanIndex & 63) === 0 && performance.now() > deadline) return; // continue next frame
      const el = scanList[scanIndex++];
      if (!isCoverZone(el)) continue;
      if (scanZones.length < COVER_ZONE_MAX) scanZones.push(el);
      if (isOverlayCandidate(el)) scanOut.push(el);
    }
    // Scan complete — swap in. If the set of covers changed, stationary
    // emotes need a full re-sample (a cover can appear without any emote
    // moving).
    if (!sameElementList(overlayCandidates, scanOut)) markOcclusionDirty();
    if (!sameElementList(coverZoneEls, scanZones)) markOcclusionDirty();
    overlayCandidates = scanOut;
    coverZoneEls = scanZones;
    scanList = null;
    scanOut = null;
    scanZones = null;
    overlayPendingNodes.length = 0;
    // v2.5.0: stamp on COMPLETION. Stamping at the start meant the deadline
    // had already passed by the time a long scan finished, so the next frame
    // started another one immediately -- a permanent ~2ms/frame tax that grew
    // with page size, rather than the intended once-a-second sample.
    lastOverlayScan = performance.now();
  }

  // Candidate rects are read once per frame and shared by every emote's
  // occlusion test (previously re-read per emote). Reset at tick start.
  let frameOverlayRects = null;
  let frameCoverRects = null;

  // Does anything that could paint over this emote actually overlap it? This
  // is a handful of rect comparisons against at most COVER_ZONE_MAX elements,
  // versus OCCLUSION_SAMPLES forced elementFromPoint hit-tests. In ordinary
  // chat (no banner over the message list) nothing overlaps, so the expensive
  // path is skipped entirely -- which is what makes autoscroll cheap, since
  // autoscroll moves every on-screen emote every frame.
  function intersectsAnyCover(imgEl, rect) {
    if (!coverZoneEls.length) return false;
    if (frameCoverRects === null) {
      const vw = window.innerWidth, vh = window.innerHeight;
      frameCoverRects = [];
      for (const el of coverZoneEls) {
        if (!el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // Same rule as activeOverlayRects: a viewport-sized box is page
        // scaffolding, not a cover.
        if (r.width >= vw * OVERLAY_MAX_VIEWPORT_FRACTION && r.height >= vh * OVERLAY_MAX_VIEWPORT_FRACTION) continue;
        frameCoverRects.push({ el, r });
      }
    }
    for (const { el, r } of frameCoverRects) {
      if (el.contains(imgEl) || imgEl.contains(el)) continue; // own subtree isn't a cover
      if (rect.left < r.right && rect.right > r.left && rect.top < r.bottom && rect.bottom > r.top) return true;
    }
    return false;
  }

  // Returns an array of client rects for the overlay candidates that could
  // legitimately cover imgEl (i.e. are not an ancestor or descendant of it
  // — those can't "cover" it in the sense we care about).
  function activeOverlayRects(imgEl) {
    if (!overlayCandidates.length) return null;
    if (frameOverlayRects === null) {
      const vw = window.innerWidth, vh = window.innerHeight;
      frameOverlayRects = [];
      for (const el of overlayCandidates) {
        if (!el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // v2.4.1: a candidate that spans essentially the whole viewport is
        // a page-level scrim/wrapper, not a pinned banner.
        if (r.width >= vw * OVERLAY_MAX_VIEWPORT_FRACTION && r.height >= vh * OVERLAY_MAX_VIEWPORT_FRACTION) continue;
        frameOverlayRects.push({ el, r });
      }
    }
    let rects = null;
    for (const { el, r } of frameOverlayRects) {
      if (el.contains(imgEl) || imgEl.contains(el)) continue;
      (rects || (rects = [])).push(r);
    }
    return rects;
  }

  // ---- Occlusion (partial-crop, not a boolean) ----------------------------
  //
  // Samples a handful of points down the emote's own rect. Returns how much
  // to inset from the top/bottom, not just whether "most" of it is covered
  // — a majority-vote boolean lets an emote draw in full over a banner
  // whenever less than half the sample points happen to be covered.

  function computeOcclusionInsets(imgEl, rowRoot, rect) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const x = rect.left + rect.width / 2;
    if (x < 0 || x >= vw) return { top: 0, bottom: 0 };

    const boundary = rowRoot || imgEl;
    const overlays = activeOverlayRects(imgEl);
    let visTop = null, visBottom = null;
    let sampled = 0;
    let firstVisible = -1, lastVisible = -1;
    for (let i = 0; i < OCCLUSION_SAMPLES; i++) {
      const frac = OCCLUSION_EDGE_INSET + (1 - 2 * OCCLUSION_EDGE_INSET) * (i / (OCCLUSION_SAMPLES - 1));
      const y = rect.top + rect.height * frac;
      if (y < 0 || y >= vh) continue;
      sampled++;

      // A pointer-events: none overlay won't be reported by
      // elementFromPoint, so test it geometrically first.
      if (overlays) {
        let covered = false;
        for (const r of overlays) {
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { covered = true; break; }
        }
        if (covered) continue;
      }

      const hit = document.elementFromPoint(x, y);
      // "Visible" = hit lands inside this element's own row subtree (or is
      // an ancestor of it, i.e. plain background) — not necessarily on
      // imgEl itself, so Twitch's own hover-highlight/reply-button UI
      // within the same row is never mistaken for a foreign overlay.
      const visible = !!hit && (boundary === hit || boundary.contains(hit) || hit.contains(boundary));
      if (visible) {
        if (visTop === null) { visTop = y; firstVisible = i; }
        visBottom = y;
        lastVisible = i;
      }
    }
    // v2.4.1: if no sample point was even testable (every y fell outside
    // the viewport), that's "we don't know", not "fully covered".
    if (visTop === null) return sampled === 0 ? { top: 0, bottom: 0 } : null;

    // v2.5.0: visTop/visBottom are SAMPLE POSITIONS, and the outermost
    // samples deliberately sit OCCLUSION_EDGE_INSET (8%) inside the emote so
    // that a row seam can't trigger a false positive. Converting them
    // straight into crop insets therefore cropped 8% off the top and 8% off
    // the bottom of every animated emote, even one with nothing whatsoever
    // over it -- 16% of a 28px chat emote, permanently, on every instance.
    //
    // If the outermost sample is visible there is nothing covering that edge,
    // so the inset is zero. Only an edge whose outermost sample was actually
    // covered gets cropped, which is what the crop is for.
    const top = firstVisible === 0 ? 0 : Math.max(0, visTop - rect.top);
    const bottom = lastVisible === OCCLUSION_SAMPLES - 1 ? 0 : Math.max(0, rect.bottom - visBottom);
    return { top, bottom };
  }

  let lastFullOcclusion = -Infinity;
  let occlusionCursor = 0;
  let occlusionDirty = true;
  const markOcclusionDirty = () => { occlusionDirty = true; };

  const ZERO_INSETS = { top: 0, bottom: 0 };
  const snapRect = (r) => ({ top: r.top, left: r.left, width: r.width, height: r.height });
  function sameRect(last, r) {
    return !!last &&
      Math.abs(r.top - last.top) < 0.5 &&
      Math.abs(r.left - last.left) < 0.5 &&
      Math.abs(r.width - last.width) < 0.5 &&
      Math.abs(r.height - last.height) < 0.5;
  }

  // v2.4.2: two independent triggers, so fast chat no longer means "full
  // re-sample every frame":
  //   - MOVED emotes (rect changed since their last sample) are re-sampled
  //     every frame, immediately. Chat scrolling a row up under the pinned
  //     message is caught the same frame it happens.
  //   - A FULL re-sample of stationary emotes happens when something
  //     outside the chat rows changed (dirty), at most every
  //     OCCLUSION_DIRTY_MIN_MS, plus a safety-net every OCCLUSION_REFRESH_MS.
  function resolveAncestors(imgEl, inst) {
    if (!inst.clipAncestor || !inst.clipAncestor.isConnected) {
      inst.clipAncestor = findScrollClipAncestor(imgEl);
      inst.rowRoot = findRowRoot(imgEl, inst.clipAncestor);
    } else if (inst.rowRoot === undefined || (inst.rowRoot && !inst.rowRoot.isConnected)) {
      inst.rowRoot = findRowRoot(imgEl, inst.clipAncestor);
    }
  }

  // v2.5.0: `live` is [{ imgEl, inst, rect }], read once per frame by tick()
  // and shared with the draw pass. updateOcclusion() previously did its own
  // getBoundingClientRect() for every instance, so every emote was measured
  // twice per frame.
  //
  // The sampling itself (up to OCCLUSION_SAMPLES forced elementFromPoint
  // hit-tests per emote) is now capped at OCCLUSION_BUDGET_MS per frame.
  // That cap is what makes positional drift impossible under load: an emote
  // that doesn't get sampled this frame keeps its cached insets and is STILL
  // repositioned from its fresh rect by the draw pass below, so the canvas
  // can never fall behind its <img>. Only the occlusion crop goes briefly
  // stale, and only while the main thread is already saturated.
  // One entry's occlusion resolution. Returns after either the cheap
  // geometric pre-test or a real hit-test, and always resolves ancestors
  // (clipAncestor feeds computeClipPath's scroll clip and knownClipAncestors).
  function sampleOcclusion(entry, roots, clips, now, full) {
    const { imgEl, inst, rect } = entry;
    resolveAncestors(imgEl, inst);
    if (inst.rowRoot) roots.add(inst.rowRoot);
    if (inst.clipAncestor) clips.add(inst.clipAncestor);
    if (!full && !intersectsAnyCover(imgEl, rect)) {
      inst.occlusionInsets = ZERO_INSETS;
    } else {
      inst.occlusionInsets = computeOcclusionInsets(imgEl, inst.rowRoot, rect);
    }
    inst.lastOcclusionRect = snapRect(rect);
    inst.lastSampleAt = now;
  }

  function updateOcclusion(now, live, vw, vh) {
    stepOverlayScan(now);

    let full = false;
    if (now - lastFullOcclusion >= OCCLUSION_REFRESH_MS) full = true;
    else if (occlusionDirty && now - lastFullOcclusion >= OCCLUSION_DIRTY_MIN_MS) full = true;
    // Stamp on SCHEDULE, not on completion. If the frame budget truncates the
    // sweep, the timer must still advance -- otherwise the "a sweep is due"
    // condition stays true forever and every frame becomes a full sweep,
    // defeating the pre-test and the throttle below.
    if (full) { occlusionDirty = false; lastFullOcclusion = now; }

    const roots = new Set();
    const clips = new Set();
    const pending = [];
    const fresh = [];

    for (const entry of live) {
      const { imgEl, inst, rect } = entry;
      if (!rect) continue;
      if (inst.rowRoot) roots.add(inst.rowRoot);
      if (inst.clipAncestor) clips.add(inst.clipAncestor);

      if (rect.width === 0 || rect.height === 0) {
        inst.occlusionInsets = null;
        inst.lastOcclusionRect = null;
        continue;
      }
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
        inst.occlusionInsets = { top: 0, bottom: 0 };
        inst.lastOcclusionRect = snapRect(rect);
        continue;
      }
      if (!full && inst.occlusionInsets !== undefined && sameRect(inst.lastOcclusionRect, rect)) {
        continue; // hasn't moved and no full re-sample due — keep cached insets
      }
      // While chat autoscrolls, every on-screen emote moves every frame, so
      // "re-sample what moved" meant hit-testing the whole visible set at the
      // display refresh rate. An emote that was sampled a frame or two ago is
      // left on its cached insets until OCCLUSION_MOVE_MIN_MS has passed.
      //
      // v2.5.3: but ONLY while it is clear of every known cover. Chat scrolls
      // ~24px per 32ms, and a row jumps a whole line at a time, so deferring
      // here let an emote travel well under the pinned message still carrying
      // its previous "unoccluded" insets — measured 8-20px of a 35px emote
      // drawn over the banner. The pre-test is rect maths against at most
      // COVER_ZONE_MAX rects, so paying it here to keep emotes near a cover
      // frame-accurate is cheap; the expensive hit-test still only runs for
      // the few emotes actually touching one.
      if (!full && inst.occlusionInsets !== undefined &&
          now - inst.lastSampleAt < OCCLUSION_MOVE_MIN_MS &&
          !intersectsAnyCover(imgEl, rect)) {
        continue;
      }
      // Never-sampled instances are serviced first and unconditionally: they
      // have no cached insets, and until they are sampled tick() refuses to
      // draw them at all. They are bounded by the emote arrival rate, not by
      // how many emotes are on screen, and the cheap cover pre-test resolves
      // most of them without a single hit-test.
      if (inst.occlusionInsets === undefined) fresh.push(entry);
      else pending.push(entry);
    }

    for (const entry of fresh) sampleOcclusion(entry, roots, clips, now, full);

    if (pending.length) {
      const deadline = performance.now() + OCCLUSION_BUDGET_MS;
      // v2.5.2: the round-robin cursor used to start mid-array, which silently
      // defeated putting new instances at the front. Freshly-attached emotes
      // are handled above now, so this cursor only paces re-sampling of
      // already-known ones.
      const start = occlusionCursor % pending.length;
      let done = 0;
      while (done < pending.length) {
        sampleOcclusion(pending[(start + done) % pending.length], roots, clips, now, full);
        done++;
        // Resume from here next frame, so a pending list longer than one
        // frame's budget still gets fully serviced instead of starving its
        // tail forever.
        if ((done & 7) === 0 && performance.now() > deadline) break;
      }
      occlusionCursor = (start + done) % pending.length;
    }

    knownRowRoots = roots;
    knownClipAncestors = clips;
  }

  // Combines the scroll-ancestor clip with the occlusion insets into one
  // CSS clip-path, or null if nothing would remain visible.
  function computeClipPath(rect, cRect, insets) {
    let top = 0, left = 0, right = 0, bottom = 0;
    if (cRect) {
      top = Math.max(top, cRect.top - rect.top);
      left = Math.max(left, cRect.left - rect.left);
      right = Math.max(right, rect.right - cRect.right);
      bottom = Math.max(bottom, rect.bottom - cRect.bottom);
    }
    if (insets) {
      top = Math.max(top, insets.top);
      bottom = Math.max(bottom, insets.bottom);
    }
    if (top + bottom >= rect.height - 0.5 || left + right >= rect.width - 0.5) return null;
    if (!top && !right && !bottom && !left) return 'none';
    return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
  }

  // ---- Render loop ---------------------------------------------------------

  function tick() {
    const now = performance.now();
    frameOverlayRects = null;
    frameCoverRects = null;
    const vw = window.innerWidth, vh = window.innerHeight;
    const clipRectCache = new Map(); // one getBoundingClientRect per scroll ancestor per frame

    // Phase 0 (read-only): measure every instance exactly once. Both the
    // occlusion pass and the draw pass below run off these rects; before
    // v2.5.0 each did its own getBoundingClientRect() per instance.
    const live = [];
    for (const [imgEl, inst] of INSTANCES) {
      live.push({ imgEl, inst, rect: imgEl.isConnected ? imgEl.getBoundingClientRect() : null });
    }
    updateOcclusion(now, live, vw, vh);

    // Phase 1 (read-only): decide what each instance should do.
    const work = [];
    for (const { imgEl, inst, rect } of live) {
      if (!rect) { work.push({ inst, imgEl, action: 'detach' }); continue; }

      // Cheap per-frame safety net alongside the MutationObserver: if
      // src/srcset changed since we last checked and it resolves to a
      // *different* known emote, resync.
      const ss = imgEl.getAttribute('srcset');
      const sa = imgEl.getAttribute('src');
      if (ss !== inst.lastSrcset || sa !== inst.lastSrc) {
        inst.lastSrcset = ss; inst.lastSrc = sa;
        const liveKey = liveKeyFor(imgEl);
        if (liveKey && liveKey !== inst.key) { work.push({ inst, imgEl, action: 'reattach' }); continue; }
      }

      const state = STATE_MAP.get(inst.key);
      // !state.frames covers a state whose bitmaps were freed under memory
      // pressure: fall back to the native <img> rather than dereference null.
      if (!state || !state.frames || state.loading || state.failed || inst.drawFailed) { work.push({ inst, imgEl, action: 'hide' }); continue; }
      if (state.staticOnly) { work.push({ inst, imgEl, action: 'restore' }); continue; } // not animated after all — hand back to Twitch's own <img>

      if (rect.width === 0 || rect.height === 0) { work.push({ inst, imgEl, action: 'hide' }); continue; }
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) { work.push({ inst, imgEl, action: 'hide' }); continue; }

      // v2.5.2: an instance whose occlusion has never been computed is NOT
      // drawn. v2.5.0 drew it with zero insets, i.e. completely unclipped, so
      // a new emote could paint straight over the pinned message until a
      // budgeted pass got round to it. Falling back to 'hide' shows the
      // native <img> instead, which sits in normal flow and is therefore
      // occluded correctly by the DOM. updateOcclusion() now services
      // never-sampled instances first, so this should almost never trigger.
      if (inst.occlusionInsets === undefined) { work.push({ inst, imgEl, action: 'hide' }); continue; }
      const insets = inst.occlusionInsets;
      if (insets === null) { work.push({ inst, imgEl, action: 'hide' }); continue; }

      let cRect = null;
      const ca = inst.clipAncestor;
      if (ca && ca.isConnected) {
        cRect = clipRectCache.get(ca);
        if (!cRect) { cRect = ca.getBoundingClientRect(); clipRectCache.set(ca, cRect); }
      }
      const clipPath = computeClipPath(rect, cRect, insets);
      if (clipPath === null) { work.push({ inst, imgEl, action: 'hide' }); continue; }

      work.push({ inst, imgEl, action: 'draw', rect, clipPath, state, now });
    }

    // Phase 2 (write-only).
    for (const { inst, imgEl, action, rect, clipPath, state, now: frameNow } of work) {
      if (action === 'detach') { detachInstance(imgEl); continue; }
      if (action === 'reattach') { detachInstance(imgEl); attachInstance(imgEl); continue; }

      if (action === 'hide' || action === 'restore') {
        // Always fall back to the native <img> instead of leaving a blank
        // hole. A state can legitimately fail to load (network hiccup,
        // unsupported format) or become temporarily unavailable — showing
        // Twitch's own (unsynced, but visible) rendering beats invisible.
        if (inst.canvas.style.display !== 'none') inst.canvas.style.display = 'none';
        if (inst.visible && RENDER_WORKER) { inst.visible = false; RENDER_WORKER.postMessage({ t: 'vis', id: inst.id, on: false }); }
        if (inst.hidden) { imgEl.style.opacity = ''; inst.hidden = false; }
        continue;
      }

      // action === 'draw'
      const canvas = inst.canvas;
      if (!inst.hidden) {
        // opacity, not visibility: visibility:hidden pulls the element out
        // of hit-testing, which breaks Twitch's own hover tooltip/click.
        imgEl.style.opacity = '0';
        inst.hidden = true;
      }

      // The canvas's CSS box always matches the full emote rect; clipping
      // (scroll ancestor + occlusion) is pure CSS clip-path, never a
      // resample. Position/size via transform+CSS px is cheap every frame.
      // v2.5.0: guarded like the width/height/clipPath writes below it.
      // Re-assigning an identical transform still dirties style for the
      // compositor, and in fast chat most emotes are stationary in any
      // given frame.
      const tf = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
      if (canvas.style.transform !== tf) canvas.style.transform = tf;
      const wPx = rect.width + 'px', hPx = rect.height + 'px';
      if (canvas.style.width !== wPx) canvas.style.width = wPx;
      if (canvas.style.height !== hPx) canvas.style.height = hPx;
      if (canvas.style.clipPath !== clipPath) canvas.style.clipPath = clipPath;

      state.lastUsed = frameNow;

      // v2.5.2: track the largest height any live copy of this emote needs
      // THIS frame, then upgrade the decode if the current frames can't cover
      // it. Reset per frame so a hover preview that has since closed doesn't
      // pin the emote at high resolution forever. decodeInto() keeps
      // state.startTime across the swap, so nothing restarts.
      const dprNow = window.devicePixelRatio || 1;
      if (state.wantFrame !== frameNow) { state.wantFrame = frameNow; state.wantPx = 0; }
      const needPx = Math.ceil(rect.height * dprNow);
      if (needPx > state.wantPx) state.wantPx = needPx;
      if (RENDER_WORKER) {
        // The worker knows what it decoded; just tell it the demand when it grows.
        if (needPx > (state.sentWantPx || 0)) { state.sentWantPx = needPx; RENDER_WORKER.postMessage({ t: 'want', key: inst.key, px: needPx }); }
        const wW = Math.max(1, Math.round(rect.width * dprNow)), wH = Math.max(1, Math.round(rect.height * dprNow));
        if (wW > inst.bmpW || wH > inst.bmpH || wW * 2 < inst.bmpW || wH * 2 < inst.bmpH) {
          inst.bmpW = wW; inst.bmpH = wH;
          RENDER_WORKER.postMessage({ t: 'size', id: inst.id, w: wW, h: wH });
        }
        if (!inst.visible) { inst.visible = true; RENDER_WORKER.postMessage({ t: 'vis', id: inst.id, on: true }); }
        if (canvas.style.display !== '') canvas.style.display = '';
        continue;
      }
      if (!state.upgrading && !state.loading && state.decodedPx &&
          state.wantPx > state.decodedPx * 1.25) {
        state.upgrading = true;
        state.targetPx = state.wantPx;
        enqueueDecode(state);
      }

      const frameIndex = currentFrameIndex(state, frameNow);
      const frame = state.frames[frameIndex].bitmap;

      // v2.5.1: size the pixel buffer to how big the emote actually IS on
      // screen (x devicePixelRatio), capped at the source bitmap so it is
      // never upscaled. It used to always match the decoded bitmap — for a
      // 7TV emote that is 128x128 backing a 28px chat emote: ~21x the pixels,
      // cleared, redrawn and composited every frame, on every copy. Measured
      // on the 7TV harness: 182MB of canvas backing store at high load.
      //
      // Twitch's enlarged hover preview is simply a bigger rect, so it gets a
      // correspondingly bigger buffer and stays sharp — which is the reason
      // the emote is decoded at full quality in the first place.
      const dpr = window.devicePixelRatio || 1;
      let wantW = Math.max(1, Math.min(frame.width, Math.round(rect.width * dpr)));
      let wantH = Math.max(1, Math.min(frame.height, Math.round(rect.height * dpr)));
      // Only resize on a real change: grow immediately, but shrink only when
      // the buffer is more than 2x too big. Without this, the hover preview's
      // scale animation would reallocate (and clear) the canvas every frame.
      if (wantW > inst.bmpW || wantH > inst.bmpH ||
          wantW * 2 < inst.bmpW || wantH * 2 < inst.bmpH) {
        canvas.width = wantW;
        canvas.height = wantH;
        inst.bmpW = wantW;
        inst.bmpH = wantH;
        // Resizing a canvas resets its 2D context state, so the smoothing
        // settings chosen in attachInstance have to be reapplied or the
        // downscale silently drops to the default low quality.
        inst.ctx.imageSmoothingEnabled = true;
        inst.ctx.imageSmoothingQuality = 'high';
        inst.lastFrameIndex = -1; // resizing clears the buffer
      }

      // v2.4.2: the canvas keeps its pixels between frames, so only
      // repaint when the shared clock has actually advanced to a new frame.
      if (frameIndex !== inst.lastFrameIndex) {
        const ctx = inst.ctx;
        ctx.clearRect(0, 0, inst.bmpW, inst.bmpH);
        try {
          ctx.drawImage(frame, 0, 0, inst.bmpW, inst.bmpH);
          inst.lastFrameIndex = frameIndex;
        } catch (e) {
          // Never show a garbled/blank frame — hide the canvas AND restore
          // the native <img> so the emote stays visible (just unsynced).
          canvas.style.display = 'none';
          imgEl.style.opacity = '';
          inst.hidden = false;
          inst.lastFrameIndex = -1;
          continue;
        }
      }
      if (canvas.style.display !== '') canvas.style.display = '';
    }

    requestAnimationFrame(tick);
  }

  // UI events that might put something over an emote without moving it
  // (a popover opening, a banner finishing its slide-in). Ignored when the
  // event happened inside a chat row — hover highlights, 7TV/FFZ row
  // animations and the like can't cover another emote, and in fast chat
  // they fire constantly.
  function onUiEvent(e) {
    if (occlusionDirty) return;
    const t = e.target;
    if (t instanceof Node && isInsideKnownRow(t)) return;
    markOcclusionDirty();
  }

  function boot() {
    ensureOverlayLayer();
    RENDER_WORKER = startRenderWorker();
    document.querySelectorAll('img').forEach(maybeAttach);
    startObserving();

    document.addEventListener('click', onUiEvent, { capture: true, passive: true });
    document.addEventListener('transitionend', onUiEvent, { capture: true, passive: true });
    document.addEventListener('animationend', onUiEvent, { capture: true, passive: true });
    window.addEventListener('resize', () => {
      markOcclusionDirty();
      lastOverlayScan = -Infinity; // geometry changed — redo the full candidate scan
    }, { passive: true });
    // v2.4.2: no scroll listener any more. Scrolling moves emotes, and moved
    // emotes are re-sampled every frame by updateOcclusion() on their own.
    // Marking the sweep dirty on scroll is what forced a full re-sample of
    // every emote on every frame while chat was auto-scrolling.

    requestAnimationFrame(tick);
  }

  document.body ? boot() : document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
