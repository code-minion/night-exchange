(() => {
  "use strict";

  const LINES = [
    { id: "01", title: "Heating Valves", blurb: "Placeholder — sample line 01 on the board." },
    { id: "02", title: "Night Hill", blurb: "Placeholder — sample line 02 on the board." },
    { id: "03", title: "Amber Relay", blurb: "Placeholder — sample line 03 on the board." },
    { id: "04", title: "Ticket Press", blurb: "Placeholder — sample line 04 on the board." },
    { id: "05", title: "Phosphor CRT", blurb: "Placeholder — sample line 05 on the board." },
    { id: "06", title: "Walnut Edge", blurb: "Placeholder — sample line 06 on the board." },
  ];

  const STRIP_STATIONS = [
    { x: 108, y: 62 }, { x: 217, y: 62 }, { x: 326, y: 62 },
    { x: 435, y: 62 }, { x: 544, y: 62 }, { x: 653, y: 62 },
  ];
  const GRID_STATIONS = [
    { x: 77, y: 74 }, { x: 195, y: 74 }, { x: 313, y: 74 },
    { x: 77, y: 188 }, { x: 195, y: 188 }, { x: 313, y: 188 },
  ];
  const STRIP_VB = { w: 760, h: 158 };
  const GRID_VB = { w: 390, h: 312 };

  const SEGMENTS = 24;
  const DESKTOP_SNAP = 40;
  const TOUCH_SNAP = 56;
  const MAGNET_PULL = 40;
  const JACK_CLICK_SWALLOW_MS = 400; // ignore a jack click this soon after a plug pointer sequence ended
  const CATCHUP_MS = 120; // after a scrub hand-off the plug catches up to the finger over this long
  const SEAT_MS = 70;
  const SEAT_DIST = 6;
  const OVERSHOOT = 2;
  const BLOOM_DELAY = 40;
  const BLOOM_MS = 180;
  const RIPPLE_STEP = 60;
  const SETTLE_MS = 800;
  const ROUTE_MS = 450;
  const LAMP_FADE_MS = 200;

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isPhoneLayout = () => matchMedia("(max-width: 819px)").matches;

  const svgCache = {};
  const state = {
    soundOn: false,
    connected: null, // line index 0..5
    used: false,
    focusIdx: 0,
    dragging: false,
    pointerId: null,
    magnetIdx: -1,
    seating: false,
    routing: false,
    swallowJackClickUntil: 0,
  };

  const el = {
    app: null, stage: null, shelf: null, hook: null, plug: null,
    canvas: null, spark: null, crt: null, crtStatus: null, crtTitle: null, crtSub: null,
    lamp: null, ticket: null, ticketK: null, ticketTitle: null, ticketBody: null,
    hangup: null, live: null, sound: null,
    jacksDesktop: null, jacksPhone: null,
  };

  let ctx = null;
  let sctx = null; // spark canvas, above the plug (spark is the top layer)
  let rope = null; // { pts: [{x,y,ox,oy}], pinned:0 }
  let plugPos = { x: 0, y: 0 };
  let hookPos = { x: 0, y: 0 };
  let jackCenters = []; // page coords for active board
  let jackBtns = []; // active buttons
  let allJackSets = { desktop: [], phone: [] };
  let lampSvg = null;
  let raf = 0;
  let seatAnim = null;
  let routeAnim = null;

  /* ——— SVG mount ——— */
  async function loadSvg(name) {
    if (svgCache[name]) return svgCache[name];
    const res = await fetch(`svg/${name}.svg`);
    const text = await res.text();
    svgCache[name] = text;
    return text;
  }

  function mountInline(host, html, { className } = {}) {
    host.innerHTML = html;
    const svg = host.querySelector("svg");
    if (!svg) return null;
    if (className) svg.classList.add(className);
    // strip fixed width/height so CSS can size
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.width = "100%";
    svg.style.height = "100%";
    return svg;
  }

  // Two plug arts, never both visible: layer 0 = original upright plug.svg (default/drag/route, 66×117),
  // layer 1 = production-B2 sprite sheet (14 frames, 120×170 CSS each) that plays the insertion.
  async function mountPlugPoses() {
    const host = document.querySelector('[data-nx-mount="plug"]');
    const G = window.NXGeo;
    host.innerHTML = "";
    const orig = document.createElement("span");
    orig.className = "nx-plug-layer";
    orig.dataset.pose = "original";
    plugSvg = mountInline(orig, await loadSvg(G.ORIGINAL.file.replace(/^svg\//, "").replace(/\.svg$/, "")));
    plugSvg.classList.add("nx-is-pulse"); // pulse is the VE svg's own class (as in P1)
    const sheet = document.createElement("span");
    sheet.className = "nx-plug-layer nx-plug-sheet";
    sheet.dataset.pose = "sheet";
    sheet.style.backgroundImage = `url(${G.SHEET.file})`;
    sheet.style.backgroundSize = `${G.SHEET.frames * G.SHEET.canvas.w}px ${G.SHEET.canvas.h}px`;
    plugLayers = [orig, sheet];
    host.append(orig, sheet);
    const img = new Image(); img.src = G.SHEET.file; // warm the cache so f00 never flashes empty
    try { await img.decode(); } catch (_) { /* decode is best-effort */ }
    const grip = document.createElement("span");
    grip.className = "nx-plug-grip";
    host.appendChild(grip);
    plugGrip = grip;
  }

  async function mountAllStatic() {
    const mounts = [
      ["board-strip", "board-strip-6"],
      ["board-grid", "board-grid-3x2"],
      ["lamp", "lamp"],
      ["pencil", "pencil"],
      ["label-coffee", "label-card-coffee"],
    ];
    await Promise.all(mounts.map(async ([key, file]) => {
      const host = document.querySelector(`[data-nx-mount="${key}"]`);
      if (!host) return;
      const html = await loadSvg(file);
      const svg = mountInline(host, html);
      if (key === "lamp") {
        lampSvg = svg;
        svg.classList.add("nx-is-off");
        svg.style.setProperty("--nx-lamp", "0");
      }
      if (key === "label-coffee") {
        const texts = svg.querySelectorAll("text");
        if (texts[0]) texts[0].textContent = "PROP";
        if (texts[1]) texts[1].textContent = "Coffee card";
      }
    }));
  }

  async function buildLabels(container, coffeeIndex) {
    const card = await loadSvg("label-card");
    const coffee = await loadSvg("label-card-coffee");
    container.innerHTML = "";
    LINES.forEach((line, i) => {
      const host = document.createElement("span");
      host.className = "nx-label-host";
      const html = i === coffeeIndex ? coffee : card;
      const svg = mountInline(host, html);
      const texts = svg.querySelectorAll("text");
      if (texts[0]) texts[0].textContent = `LINE ${line.id}`;
      if (texts[1]) texts[1].textContent = line.title;
      // Unique ids for gradients when inlined multiple times — rename
      uniquifyIds(svg, `lbl${container.id}${i}`);
      container.appendChild(host);
    });
  }

  function uniquifyIds(svg, prefix) {
    const ids = [...svg.querySelectorAll("[id]")].map((n) => n.id);
    ids.forEach((id) => {
      const neu = `${prefix}-${id}`;
      svg.querySelector(`#${CSS.escape(id)}`)?.setAttribute("id", neu);
      svg.querySelectorAll(`[fill="url(#${id})"],[stroke="url(#${id})"],[clip-path="url(#${id})"],[href="#${id}"]`).forEach((n) => {
        for (const attr of ["fill", "stroke", "clip-path", "href", "xlink:href"]) {
          const v = n.getAttribute(attr);
          if (v && v.includes(`#${id}`)) n.setAttribute(attr, v.replace(`#${id}`, `#${neu}`));
        }
      });
      // style urls in attributes
      svg.querySelectorAll("*").forEach((n) => {
        for (const attr of [...n.attributes]) {
          if (attr.value.includes(`url(#${id})`)) {
            n.setAttribute(attr.name, attr.value.replaceAll(`url(#${id})`, `url(#${neu})`));
          }
        }
      });
    });
  }

  async function buildJacks(container, boardKind) {
    const jackHtml = await loadSvg("jack");
    container.innerHTML = "";
    const list = [];
    LINES.forEach((line, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nx-jack-btn";
      btn.dataset.line = String(i);
      btn.setAttribute("aria-label", `Line ${line.id}, ${line.title}, connect`);
      btn.tabIndex = i === 0 ? 0 : -1;
      const host = document.createElement("span");
      host.className = "nx-jack-host";
      const svg = mountInline(host, jackHtml);
      uniquifyIds(svg, `jack${boardKind}${i}`);
      btn._jackSvg = svg;
      btn.appendChild(host);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        onJackActivate(i);
      });
      btn.addEventListener("keydown", (e) => onJackKey(e, i, boardKind));
      container.appendChild(btn);
      list.push(btn);
    });
    allJackSets[boardKind] = list;
    return list;
  }

  /* ——— layout geometry ——— */
  function activeBoard() {
    return isPhoneLayout() ? "grid" : "strip";
  }

  function boardHostEl() {
    return document.querySelector(
      isPhoneLayout() ? "#nx-board-phone .nx-board-host" : "#nx-board-desktop .nx-board-host"
    );
  }

  function activeJackContainer() {
    return isPhoneLayout() ? el.jacksPhone : el.jacksDesktop;
  }

  function layoutJacks() {
    const G = window.NXGeo;
    const board = activeBoard();
    const host = boardHostEl();
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const stageRect = el.stage.getBoundingClientRect();
    const container = activeJackContainer();
    const cRect = container.getBoundingClientRect();
    const btns = board === "strip" ? allJackSets.desktop : allJackSets.phone;
    jackBtns = btns;
    // Stage frame (canvas, plug, cord, hit tests) and container frame (DOM buttons)
    // come from the same station table; only the origin differs.
    const stageC = G.socketCenters(board, rect.left - stageRect.left, rect.top - stageRect.top, rect.width);
    const localC = G.socketCenters(board, rect.left - cRect.left, rect.top - cRect.top, rect.width);
    jackCenters = stageC;
    plugJ = G.jackSize(board, rect.width);
    localC.forEach((c, i) => {
      const btn = btns[i];
      if (!btn) return;
      const hb = G.hitBox(c);
      Object.assign(btn.style, { left: hb.left + "px", top: hb.top + "px", width: hb.width + "px", height: hb.height + "px" });
      const jb = G.jackBox(board, c, rect.width);
      const jh = btn.firstChild;
      Object.assign(jh.style, { left: (jb.left - hb.left) + "px", top: (jb.top - hb.top) + "px", width: jb.width + "px", height: jb.height + "px" });
    });
  }

  function layoutHookAndPlug(resetRope) {
    const stageRect = el.stage.getBoundingClientRect();
    const hookRect = el.hook.getBoundingClientRect();
    hookPos = {
      x: hookRect.left + hookRect.width / 2 - stageRect.left,
      y: hookRect.top + 4 - stageRect.top,
    };
    if (state.connected == null && !state.dragging && !state.seating && !state.routing) {
      plugPose = POSE.ORIGINAL;
      plugPos = homeTip();
      placePlugEl();
      if (resetRope || !rope) initRope();
    } else if (state.connected != null && jackCenters[state.connected]) {
      const c = jackCenters[state.connected];
      plugPos = sockRef(c);
      plugPose = POSE.SHEET; plugFrame = window.NXGeo.SHEET.frames - 1;
      placePlugEl();
      if (resetRope) initRopePinnedToJack();
    }
  }

  // plugPos = R, the world (stage px) position of the sprite's socket reference (40,40.4).
  // plugPose = NXGeo.POSE.ORIGINAL (0, the upright plug) or POSE.SHEET (2, the B2 sprite sheet at plugFrame 0–13).
  const POSE = window.NXGeo.POSE;
  let plugPose = 0;
  let plugFrame = 0;
  let plugJ = 84;
  // World point the plug reference must reach to be seated on jack idx: the black core centre (station + 0.4 unit).
  function sockRef(c) { return window.NXGeo.socketRef(c, plugJ); }
  let plugLayers = [];
  let plugGrip = null;
  let plugSvg = null;
  function placePlugEl() {
    const G = window.NXGeo;
    const d = G.display(plugPos, plugJ, plugPose, plugFrame); // exactly one plug art is visible
    el.plug.style.left = `${d.origin.x}px`;
    el.plug.style.top = `${d.origin.y}px`;
    el.plug.style.width = `${d.width}px`;
    el.plug.style.height = `${d.height}px`;
    plugLayers.forEach((layer, i) => {
      const on = i === d.frame;
      layer.style.opacity = on ? "1" : "0";
      layer.style.visibility = on ? "visible" : "hidden";
    });
    if (plugPose === POSE.SHEET) plugLayers[1].style.backgroundPosition = `${-d.sheetFrame * G.SHEET.canvas.w}px 0`;
    // Grab area: original = P1's whole plug box; sheet = the 37px seated head (the 120×170 sprite box is mostly empty).
    if (plugGrip) {
      const g = d.grip;
      Object.assign(plugGrip.style, {
        left: `${g.x - d.origin.x - g.rx}px`, top: `${g.y - d.origin.y - g.ry}px`,
        width: `${2 * g.rx}px`, height: `${2 * g.ry}px`, borderRadius: g.round ? "50%" : "0",
      });
    }
    // Phone seated: inert (tap on the lit jack = hang up; touch has no drag-out). Also inert while the frames play.
    el.plug.classList.toggle("nx-plug-docked", plugPose === POSE.SHEET && plugFrame === G.SHEET.frames - 1);
    el.plug.classList.toggle("nx-plug-inert", plugPose === POSE.SHEET && (isPhoneLayout() || state.connected == null));
  }

  function cordTip() { return window.NXGeo.cordWorld(plugPos, plugJ, plugPose, plugFrame); }
  function homeTip() { return window.NXGeo.restRef(hookPos, plugJ); }

  /** Blend pose p over ms (reverse on unplug). Reduced motion: jump. */
  /** Run frame(ms) → {R,pose} each rAF for `ms`; cancelled (→ false) by a newer motion. */
  function runFrames(ms, frame) {
    const gen = motionGen;
    return new Promise((resolve) => {
      const t0 = performance.now();
      function step(now) {
        if (gen !== motionGen) return resolve(false);
        const e = Math.min(ms, now - t0), f = frame(e);
        if (f.pose === POSE.ORIGINAL) plugPos = f.R; // the sheet pose is only ever entered through swapPlug()
        if (e < ms) requestAnimationFrame(step); else resolve(true);
      }
      requestAnimationFrame(step);
    });
  }

  /** Play the sheet forward (reverse=false: f00→f13 over 210ms) or backward (13→00, same intervals). Cancelled by a newer motion. */
  function playSheet(reverse, from) {
    const G = window.NXGeo, gen = motionGen, total = G.SHEET.seatMs, e0 = from || 0;
    return new Promise((resolve) => {
      const t0 = performance.now();
      function step(now) {
        if (gen !== motionGen) return resolve(false);
        const e = Math.min(total, e0 + now - t0);
        plugFrame = reverse ? G.sheetFrameReverse(e) : G.sheetFrame(e);
        if (e < total) requestAnimationFrame(step); else resolve(true);
      }
      requestAnimationFrame(step);
    });
  }
  /** CSS-only seat overshoot after f13: scale 1 → 1.04 → 1.01 → 1 about S (transform-origin in CSS), no translate. */
  function seatBounce() {
    const layer = plugLayers[1];
    if (reduceMotion || !layer) return;
    layer.classList.remove("is-seated"); void layer.offsetWidth; layer.classList.add("is-seated");
    setTimeout(() => layer.classList.remove("is-seated"), window.NXGeo.SHEET.bounce.ms + 20);
  }

  /** THE SWAP — the one place the plug art changes (everything else calls this).
      to = "seated": upright plug → sheet f00…f13 (210ms) on the socket ref, then the CSS bounce. Resolves true when f13
        has been reached (caller clacks immediately); false if superseded. Reduced motion: straight to f13.
      to = "original": sheet f13…f00 (210ms, no bounce) → upright plug with its tip on the socket. opts.instant skips the
        frames (reduced motion, and drag-out where the plug follows the finger). `socket` = NXGeo.socketRef of the jack. */
  async function swapPlug(to, socket, opts) {
    const G = window.NXGeo, last = G.SHEET.frames - 1;
    if (to === "seated") {
      plugPos = { x: socket.x, y: socket.y }; plugPose = POSE.SHEET; plugFrame = 0; placePlugEl();
      if (reduceMotion) { plugFrame = last; placePlugEl(); return true; }
      if (!(await playSheet(false))) return false;
      plugFrame = last; placePlugEl(); seatBounce();
      return true;
    }
    if (!(reduceMotion || (opts && opts.instant))) {
      // continue from the frame on screen (a scrubbed-out plug that is hung up mid-pull must not jump back to f13)
      const was = plugPose === POSE.SHEET, r0 = was ? G.SHEET.seatMs - G.SHEET.ms[plugFrame] : 0;
      plugPos = { x: socket.x, y: socket.y }; plugPose = POSE.SHEET; if (!was) plugFrame = last; placePlugEl();
      if (!(await playSheet(true, r0))) return false;
    }
    plugPos = G.refFromTip(socket); plugPose = POSE.ORIGINAL; plugFrame = 0; placePlugEl();
    return true;
  }

  function sizeCanvas() {
    const rect = el.stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.width = Math.floor(rect.width * dpr);
    el.canvas.height = Math.floor(rect.height * dpr);
    el.canvas.style.width = `${rect.width}px`;
    el.canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    el.spark.width = el.canvas.width; el.spark.height = el.canvas.height;
    el.spark.style.width = el.canvas.style.width; el.spark.style.height = el.canvas.style.height;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ——— verlet rope ——— */
  function initRope() {
    const end = cordTip();
    const pts = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const x = hookPos.x + (end.x - hookPos.x) * t;
      const y = hookPos.y + (end.y - hookPos.y) * t + Math.sin(t * Math.PI) * 10;
      pts.push({ x, y, ox: x, oy: y });
    }
    rope = { pts };
  }

  function initRopePinnedToJack() {
    initRope();
  }

  function verletStep(gravity, iterations) {
    if (!rope) return;
    const pts = rope.pts;
    const n = pts.length;
    // integrate
    for (let i = 1; i < n; i++) {
      const p = pts[i];
      if (i === n - 1) {
        const tip = cordTip();
        p.ox = p.x;
        p.oy = p.y;
        p.x = tip.x;
        p.y = tip.y;
        continue;
      }
      const vx = (p.x - p.ox) * 0.98;
      const vy = (p.y - p.oy) * 0.98;
      p.ox = p.x;
      p.oy = p.y;
      p.x += vx;
      p.y += vy + gravity;
    }
    // pin start to hook
    pts[0].x = hookPos.x;
    pts[0].y = hookPos.y;
    pts[0].ox = hookPos.x;
    pts[0].oy = hookPos.y;

    // distance constraints
    const tip = cordTip();
    const rest = hypot(tip.x - hookPos.x, tip.y - hookPos.y) / SEGMENTS;
    const restLen = Math.max(rest, 10);
    for (let k = 0; k < iterations; k++) {
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const diff = (d - restLen) / d;
        const offx = dx * 0.5 * diff;
        const offy = dy * 0.5 * diff;
        if (i === 0) {
          b.x -= offx * 2;
          b.y -= offy * 2;
        } else if (i === n - 2) {
          a.x += offx * 2;
          a.y += offy * 2;
        } else {
          a.x += offx;
          a.y += offy;
          b.x -= offx;
          b.y -= offy;
        }
      }
      pts[0].x = hookPos.x;
      pts[0].y = hookPos.y;
      {
        const tip = cordTip();
        pts[n - 1].x = tip.x;
        pts[n - 1].y = tip.y;
      }
    }
  }

  function hypot(a, b) { return Math.sqrt(a * a + b * b); }

  function drawCord() {
    if (!ctx || !rope) return;
    const pts = rope.pts;
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    // shadow
    ctx.beginPath();
    ctx.moveTo(pts[0].x + 2, pts[0].y + 3);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + 2, pts[i].y + 3);
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    // cord body
    const grad = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[pts.length - 1].x, pts[pts.length - 1].y);
    grad.addColorStop(0, "#541418");
    grad.addColorStop(0.45, "#7a1e22");
    grad.addColorStop(1, "#8c2a2a");
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 5.5;
    ctx.stroke();
    // highlight
    ctx.beginPath();
    ctx.moveTo(pts[0].x - 1, pts[0].y - 1);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - 1, pts[i].y - 1);
    ctx.strokeStyle = "rgba(160,120,114,0.35)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  /* ——— local arc (one-shot) ——— */
  const arc = window.NXGeo.createArc();
  function arcTick(now) {
    const G = window.NXGeo;
    sctx.clearRect(0, 0, el.spark.width, el.spark.height);
    const tip = G.tipWorld(plugPos, plugPose); // the original plug's visible brass tip; null once seated
    const contact = state.connected != null || plugPose === POSE.SHEET;
    let d = Infinity, idx = -1, end = null;
    if (tip) {
      idx = state.arcTarget != null ? state.arcTarget : G.nearest(jackCenters, tip, Infinity);
      if (jackCenters[idx]) { end = sockRef(jackCenters[idx]); d = Math.hypot(end.x - tip.x, end.y - tip.y); }
    }
    const on = arc.update(d, idx, contact, now, reduceMotion);
    if (on && tip && end && d >= G.TRAJ.minArcPx) drawArc(tip, end, now);
  }
  function drawArc(a, b, now) {
    const n = 7, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const seed = Math.floor(now / 16);
    sctx.save();
    sctx.lineCap = "round"; sctx.lineJoin = "round";
    for (const [w, col] of [[3, "rgba(238,154,64,0.45)"], [1, "rgba(243,235,221,0.95)"]]) {
      sctx.beginPath(); sctx.moveTo(a.x, a.y);
      for (let k = 1; k < n; k++) {
        const t = k / n, j = (Math.sin((seed + k) * 12.9898) * 43758.5453) % 1;
        const off = j * Math.min(3, len * 0.25);
        sctx.lineTo(a.x + dx * t + nx * off, a.y + dy * t + ny * off);
      }
      sctx.lineTo(b.x, b.y);
      sctx.strokeStyle = col; sctx.lineWidth = w; sctx.stroke();
    }
    sctx.restore();
  }

  function loop(now) {
    if (state.dragging && state.catchUp != null && state.lastPtr) dragPlugTo(state.lastPtr.x, state.lastPtr.y);
    verletStep(0.45, 3);
    drawCord();
    arcTick(now || performance.now());
    placePlugEl();
    raf = requestAnimationFrame(loop);
  }

  /* ——— jack visual state ——— */
  function setJackLit(idx, amount) {
    jackBtns.forEach((btn, i) => {
      const svg = btn._jackSvg;
      if (!svg) return;
      if (i === idx && amount > 0) {
        if (amount >= 1) {
          svg.classList.add("nx-is-lit");
          svg.style.setProperty("--nx-lit", "1");
        } else {
          svg.classList.remove("nx-is-lit");
          svg.style.setProperty("--nx-lit", String(amount));
        }
      } else if (state.connected === i) {
        svg.classList.add("nx-is-lit");
        svg.style.setProperty("--nx-lit", "1");
      } else {
        svg.classList.remove("nx-is-lit");
        svg.style.setProperty("--nx-lit", "0");
      }
    });
    // mirror to other board set
    const other = isPhoneLayout() ? allJackSets.desktop : allJackSets.phone;
    other.forEach((btn, i) => {
      const svg = btn._jackSvg;
      if (!svg) return;
      if (state.connected === i) {
        svg.classList.add("nx-is-lit");
        svg.style.setProperty("--nx-lit", "1");
      } else if (i === idx && amount > 0) {
        svg.style.setProperty("--nx-lit", String(amount));
        if (amount >= 1) svg.classList.add("nx-is-lit");
      } else {
        svg.classList.remove("nx-is-lit");
        svg.style.setProperty("--nx-lit", "0");
      }
    });
  }

  function setLamp(intensity, className) {
    if (!lampSvg) return;
    lampSvg.classList.remove("nx-is-off", "nx-is-dim", "nx-is-bloom");
    if (className) lampSvg.classList.add(className);
    lampSvg.style.setProperty("--nx-lamp", String(intensity));
  }

  function animateLamp(from, to, ms, className) {
    if (reduceMotion) {
      setLamp(to, className || (to >= 1 ? "nx-is-bloom" : to > 0 ? "nx-is-dim" : "nx-is-off"));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const t0 = performance.now();
      function step(now) {
        const t = Math.min(1, (now - t0) / ms);
        const eased = 1 - Math.pow(1 - t, 2); // ease-out
        const v = from + (to - from) * eased;
        setLamp(v, className);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  /* ——— sound stubs ——— */
  function playStub(kind) {
    if (!state.soundOn) return;
    // Procedural micro-click via Web Audio — not a CC0 file; silent if AudioContext unavailable.
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!playStub.ctx) playStub.ctx = new AC();
      const ctxA = playStub.ctx;
      if (ctxA.state === "suspended") ctxA.resume();
      const o = ctxA.createOscillator();
      const g = ctxA.createGain();
      o.connect(g);
      g.connect(ctxA.destination);
      const now = ctxA.currentTime;
      if (kind === "clack") {
        o.type = "square";
        o.frequency.setValueAtTime(180, now);
        o.frequency.exponentialRampToValueAtTime(60, now + 0.05);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.12, now + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
        o.start(now);
        o.stop(now + 0.08);
      } else if (kind === "relay") {
        o.type = "triangle";
        o.frequency.setValueAtTime(420, now);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        o.start(now);
        o.stop(now + 0.13);
      } else if (kind === "ticket") {
        o.type = "sawtooth";
        o.frequency.setValueAtTime(880, now);
        o.frequency.linearRampToValueAtTime(440, now + 0.15);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.04, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        o.start(now);
        o.stop(now + 0.22);
      }
    } catch (_) { /* stub silent */ }
  }

  function announce(msg) {
    el.live.textContent = "";
    requestAnimationFrame(() => { el.live.textContent = msg; });
  }

  /* ——— connect / hangup ——— */
  function nearestJack(x, y, radius) {
    return window.NXGeo.nearest(jackCenters, { x, y }, radius);
  }

  function markUsed() {
    if (state.used) return;
    state.used = true;
    if (plugSvg) plugSvg.classList.remove("nx-is-pulse");
  }

  async function seatInto(idx, opts) {
    if (state.seating) return;
    const target = jackCenters[idx];
    if (!target) return;

    // If already connected to another, hang up visuals first then re-route
    if (state.connected != null && state.connected !== idx) {
      await softDisconnect();
    }

    markUsed();
    state.seating = true;
    state.magnetIdx = -1;

    if (reduceMotion) {
      await swapPlug("seated", sockRef(target)); // straight to f13
      finishConnect(idx);
      state.seating = false;
      return;
    }

    // Route (tap/keyboard): the tip already decelerated onto the socket by contactAt. Drag release: the tip closes
    // its last offset to rest on the socket in 70ms. Either way: the swap plays f00→f13 (210ms), clack on f13, lamp +40ms.
    const G = window.NXGeo;
    const sk = sockRef(target);
    if (!(opts && opts.fromRoute)) {
      const tip0 = G.tipWorld(plugPos, plugPose);
      const v0 = { x: tip0.x - sk.x, y: tip0.y - sk.y };
      if (!(await runFrames(G.CLOSE_MS, (ms) => G.dragSeatFrame(sk, plugJ, v0, ms)))) { state.seating = false; return; }
    }
    if (!(await swapPlug("seated", sk))) { state.seating = false; return; } // superseded mid-frames
    playStub("clack"); // f13, 210ms after contact
    if (navigator.vibrate) {
      try { navigator.vibrate(15); } catch (_) {}
    }
    finishConnect(idx);
    state.seating = false;
  }

  let motionGen = 0;
  function animatePlug(from, to, ms) {
    const gen = motionGen;
    return new Promise((resolve) => {
      const t0 = performance.now();
      function step(now) {
        if (gen !== motionGen) return resolve(false);
        const t = Math.min(1, (now - t0) / ms);
        const e = t * t * (3 - 2 * t);
        plugPos.x = from.x + (to.x - from.x) * e;
        plugPos.y = from.y + (to.y - from.y) * e;
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  function finishConnect(idx) {
    state.connected = idx;
    setJackLit(idx, 1);
    const line = LINES[idx];

    // bloom 40ms later
    const bloom = () => {
      animateLamp(0, 1, reduceMotion ? 0 : BLOOM_MS, "nx-is-bloom");
      playStub("relay");
      // neighbour ripple
      if (!reduceMotion) {
        [idx - 1, idx + 1, idx - 2, idx + 2].forEach((n, order) => {
          if (n < 0 || n > 5 || n === idx) return;
          setTimeout(() => {
            const btn = jackBtns[n];
            if (!btn || state.connected !== idx) return;
            const svg = btn._jackSvg;
            if (!svg) return;
            svg.style.setProperty("--nx-lit", String(Math.max(0.15, 0.45 - order * 0.12)));
            setTimeout(() => {
              if (state.connected !== n) svg.style.setProperty("--nx-lit", state.connected === n ? "1" : "0");
            }, 180);
          }, RIPPLE_STEP * (order + 1));
        });
        // dim lamp ripple pulse via --nx-lamp mid values briefly on neighbours only (jack rim)
      }
    };
    if (reduceMotion) bloom();
    else setTimeout(bloom, BLOOM_DELAY);

    // CRT resolve: noise -> title in ~300ms
    el.crt.classList.remove("is-resolved");
    el.crt.classList.add("is-resolving");
    el.crtStatus.textContent = `> LINE ${line.id} · CONNECTED · SAMPLE`;
    el.crtSub.textContent = "RINGING THROUGH ▸ TICKET PRINTING…";
    const applyTitle = () => {
      el.crtTitle.textContent = line.title.toUpperCase();
      el.crt.classList.remove("is-resolving");
      el.crt.classList.add("is-resolved");
    };
    if (reduceMotion) applyTitle();
    else setTimeout(applyTitle, 300);

    // ticket
    el.ticketK.textContent = `LINE ${line.id} · CALL TICKET · SAMPLE`;
    el.ticketTitle.textContent = line.title;
    el.ticketBody.textContent = line.blurb;
    requestAnimationFrame(() => {
      el.ticket.classList.add("is-open");
      playStub("ticket");
    });

    announce(`Connected to Line ${line.id}, ${line.title}`);
    setTimeout(() => el.hangup.focus(), 100);

    // keep cord settling — tip pinned; gravity continues in loop for ~800ms feel
  }

  async function softDisconnect() {
    // clear lamp/ticket/crt quickly before re-route
    el.ticket.classList.remove("is-open");
    el.crt.classList.remove("is-resolved", "is-resolving");
    const old = jackCenters[state.connected];
    setJackLit(-1, 0);
    state.connected = null;
    await Promise.all([animateLamp(1, 0, reduceMotion ? 0 : 80, "nx-is-off"), (old && swapPlug("original", sockRef(old)))]);
  }

  async function hangUp() {
    const myGen = ++motionGen;
    if (state.connected == null && !state.dragging) {
      // swing back if mid-air
    }
    const fromIdx = state.connected;
    state.connected = null;
    state.scrub = null; state.press = null;
    state.magnetIdx = -1;
    setJackLit(-1, 0);

    el.ticket.classList.remove("is-open");

    el.crt.classList.remove("is-resolved", "is-resolving");
    el.crtStatus.textContent = "> STANDBY · PICK UP THE RED CORD";
    el.crtTitle.textContent = "GOOD EVENING.";
    el.crtSub.textContent = "PATCH A LINE TO BEGIN_";

    animateLamp(
      Number(lampSvg?.style.getPropertyValue("--nx-lamp") || 0),
      0,
      reduceMotion ? 0 : LAMP_FADE_MS,
      "nx-is-off"
    );

    announce("Disconnected");

    if (reduceMotion) {
      plugPose = POSE.ORIGINAL;
      plugPos = homeTip();
      placePlugEl();
      initRope();
    } else {
      // sheet f13→f00 (210ms, no bounce), then the upright plug with its tip on the socket; then the cord swings home
      if (fromIdx != null) await swapPlug("original", sockRef(jackCenters[fromIdx]));
      else if (plugPose === POSE.SHEET) await swapPlug("original", plugPos, { instant: true }); // cancelled mid-seat
      // swing back
      if (myGen === motionGen) await animatePlug(plugPos, homeTip(), 520);
      // give rope leftover velocity for settle
      if (rope) {
        const tip = rope.pts[rope.pts.length - 1];
        tip.ox = tip.x - 4;
        tip.oy = tip.y + 2;
      }
    }

    if (myGen !== motionGen) return; // a new dial took over mid-swing; it owns focus
    if (fromIdx != null && jackBtns[fromIdx]) {
      jackBtns[fromIdx].focus();
    } else {
      el.plug.focus();
    }
  }

  async function routeToJack(idx) {
    if (state.routing) return;
    state.routing = true;
    try { await routeToJackInner(idx); } catch (err) { state.routing = false; state.arcTarget = null; throw err; } // never leave routing stuck
  }

  async function routeToJackInner(idx) {
    const myGen = ++motionGen;
    markUsed();
    // a tap during a hang-up's reverse frames (connected is already null, the sheet is still showing): cancel it, plug upright on the socket
    if (state.connected == null && plugPose === POSE.SHEET) await swapPlug("original", plugPos, { instant: true });

    if (state.connected != null && state.connected !== idx) {
      await softDisconnect();
    }

    const target = jackCenters[idx];
    if (!target) { state.routing = false; return; }

    if (reduceMotion) {
      await swapPlug("seated", sockRef(target)); // straight to f13
      playStub("clack");
      finishConnect(idx);
      state.routing = false;
      return;
    }

    // Route (NXGeo.routeFrame): the ORIGINAL plug's visible tip travels (450ms) and decelerates to rest on the socket
    // over the final 70ms (contact at 520ms), arriving from below. Then seatInto plays the B2 frames via swapPlug.
    const G = window.NXGeo;
    const S = G.tipWorld(plugPos, plugPose);
    const sk = sockRef(target);
    const plan = G.planRoute(S, sk, jackCenters.filter((c) => c.i !== idx));
    state.arcTarget = idx; // auto-route: the arc only ever targets the destination socket
    await runFrames(G.TRAJ.contactAt, (ms) => G.routeFrame(S, sk, plugJ, ms, plan));
    state.routing = false;
    if (myGen !== motionGen) { if (state.arcTarget === idx) state.arcTarget = null; return; } // superseded mid-route
    await seatInto(idx, { fromRoute: true });
    state.arcTarget = null;
  }

  /** Phone: tapping the lit jack again = "answer" (spec): the ticket stays up as the card, focus goes to its Hang up button. */
  function answerCall(idx) {
    const line = LINES[idx];
    el.ticket.classList.add("is-open");
    announce(`Answered Line ${line.id}, ${line.title}`);
    el.hangup.focus();
  }

  function onJackActivate(idx) {
    if (state.dragging || state.seating) return;
    // A click that trails a plug pointer sequence (hang-up / scrub / drop) must not be read as a second tap on the jack under the plug.
    if (performance.now() < state.swallowJackClickUntil) return;
    if (state.connected === idx) {
      // Spec: desktop = clicking the lit jack (or its plug) hangs up. Phone = tapping it again answers; hang up is the card's button / Esc.
      if (isPhoneLayout()) answerCall(idx); else hangUp();
      return;
    }
    routeToJack(idx); // another jack while connected: unplug, re-route and connect in one motion
  }

  /* ——— pointer drag ——— */
  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    markUsed();
    state.pointerId = e.pointerId;
    el.plug.setPointerCapture(e.pointerId);
    const sr = el.stage.getBoundingClientRect();
    if (plugPose === POSE.SHEET && state.connected != null) {
      // Seated (desktop): a plain click (< SCRUB.slop px) hangs up; pulling scrubs f13→f00 over 40px, then drags the plug out.
      ++motionGen; state.scrub = null; // cancels a settle-back still running from an earlier pull
      state.press = { x: e.clientX, y: e.clientY };
      return;
    }
    state.dragging = true; state.catchUp = null;
    state.grab = { x: plugPos.x - (e.clientX - sr.left), y: plugPos.y - (e.clientY - sr.top) };
  }

  /** Pull the plugged-in plug out under the finger: the upright plug replaces the sheet (swapPlug, instant). */
  function beginDragOut(e) {
    const idx = state.connected, sr = el.stage.getBoundingClientRect();
    state.press = null; state.scrub = null;
    state.connected = null;
    setJackLit(-1, 0);
    el.ticket.classList.remove("is-open");
    el.crt.classList.remove("is-resolved", "is-resolving");
    animateLamp(1, 0, 100, "nx-is-off");
    ++motionGen;
    swapPlug("original", sockRef(jackCenters[idx]), { instant: true }); // the plug follows the finger: no frames
    el.crtStatus.textContent = "> STANDBY · PICK UP THE RED CORD";
    el.crtTitle.textContent = "GOOD EVENING.";
    el.crtSub.textContent = "PATCH A LINE TO BEGIN_";
    state.dragging = true;
    state.grab = { x: plugPos.x - (e.clientX - sr.left), y: plugPos.y - (e.clientY - sr.top) };
    // the plug is still at the socket (f00, tip on it) while the finger is 40px away: let the hold point catch up to it
    if (!reduceMotion) state.catchUp = performance.now();
    state.lastPtr = { x: e.clientX, y: e.clientY };
  }

  /** Plug hold point under the finger (+ the grab offset, which decays to P1's hold-point-under-finger after a scrub). */
  function dragPlugTo(clientX, clientY) {
    const sr = el.stage.getBoundingClientRect();
    let g = state.grab || { x: 0, y: 0 };
    if (state.catchUp != null) {
      const w = Math.max(0, 1 - (performance.now() - state.catchUp) / CATCHUP_MS);
      if (w === 0) state.catchUp = null;
      g = { x: g.x * w, y: g.y * w };
    }
    plugPos = { x: clientX - sr.left + g.x, y: clientY - sr.top + g.y };
  }

  /** Released before the 40px: frames run back to f13 (no bounce, no clack). The plug stays connected throughout. */
  function settleScrub() {
    const G = window.NXGeo, s = state.scrub, gen = motionGen;
    state.scrub = null;
    if (!s) return;
    const r0 = G.scrubSettleMs(s.d), t0 = performance.now();
    function step(now) {
      if (gen !== motionGen) return;
      const r = Math.min(r0, Math.max(0, r0 - (now - t0)));
      plugFrame = r > 0 ? G.sheetFrameReverse(r) : G.SHEET.frames - 1;
      if (r > 0) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function onPointerMove(e) {
    if (e.pointerId !== state.pointerId) return;
    if (state.press) {
      const G = window.NXGeo, d = Math.hypot(e.clientX - state.press.x, e.clientY - state.press.y);
      if (d <= G.SCRUB.slop && !state.scrub) return;               // still a click
      if (reduceMotion || d >= G.SCRUB.px) { beginDragOut(e); return; } // reduced motion: instant swap; else handoff at 40px
      state.scrub = { d };
      plugFrame = G.scrubFrame(d);                                  // pose stays on the sheet at R = socket: cord follows the frame's exit
      return;
    }
    if (!state.dragging) return;
    state.lastPtr = { x: e.clientX, y: e.clientY };
    dragPlugTo(e.clientX, e.clientY);
    const tip = window.NXGeo.tipWorld(plugPos, plugPose);
    const near = tip ? nearestJack(tip.x, tip.y, MAGNET_PULL) : -1;
    if (near >= 0) {
      state.magnetIdx = near;
      setJackLit(near, 0.45);
      // slight magnetic pull on the tip (moves the whole plug rigidly)
      const c = window.NXGeo.socketRef(jackCenters[near], plugJ);
      const d = hypot(c.x - tip.x, c.y - tip.y);
      if (d > 0 && d < MAGNET_PULL) {
        const pull = (1 - d / MAGNET_PULL) * 0.18;
        plugPos.x += (c.x - tip.x) * pull;
        plugPos.y += (c.y - tip.y) * pull;
      }
    } else if (state.magnetIdx >= 0) {
      state.magnetIdx = -1;
      setJackLit(-1, 0);
    }
  }

  async function onPointerUp(e) {
    if (e.pointerId !== state.pointerId) return;
    state.swallowJackClickUntil = performance.now() + JACK_CLICK_SWALLOW_MS;
    if (state.press) { // press on the seated plug: click → hang up (plays the reverse); early release of a pull → settle back
      const pulled = !!state.scrub; state.press = null; state.pointerId = null;
      if (pulled) settleScrub(); else if (state.connected != null) hangUp();
      return;
    }
    if (!state.dragging) return;
    state.dragging = false;
    state.pointerId = null;
    const snapR = (e.pointerType === "touch") ? TOUCH_SNAP : DESKTOP_SNAP;
    const tip = window.NXGeo.tipWorld(plugPos, plugPose);
    const near = tip ? nearestJack(tip.x, tip.y, snapR) : -1;
    if (near >= 0) {
      await seatInto(near);
    } else {
      setJackLit(-1, 0);
      // swing back to hook
      {
        const home = homeTip();
        if (reduceMotion) plugPos = { ...home };
        else await animatePlug(plugPos, home, 520);
      }
    }
  }

  /* ——— keyboard ——— */
  function onJackKey(e, idx, boardKind) {
    const cols = boardKind === "phone" || isPhoneLayout() ? 3 : 6;
    let next = idx;
    if (e.key === "ArrowRight") next = Math.min(5, idx + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (e.key === "ArrowDown") next = Math.min(5, idx + cols);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - cols);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onJackActivate(idx);
      return;
    } else return;
    if (next !== idx) {
      e.preventDefault();
      jackBtns[idx].tabIndex = -1;
      jackBtns[next].tabIndex = 0;
      jackBtns[next].focus();
      state.focusIdx = next;
    }
  }

  function onGlobalKey(e) {
    if (e.key === "m" || e.key === "M") {
      if (e.target.closest("input,textarea")) return;
      e.preventDefault();
      toggleSound();
      return;
    }
    if (e.key === "Escape") {
      if (state.connected != null) {
        e.preventDefault();
        hangUp();
      }
      return;
    }
    if (e.key >= "1" && e.key <= "6") {
      if (e.target.closest("input,textarea")) return;
      e.preventDefault();
      const idx = Number(e.key) - 1;
      if (state.connected === idx) hangUp();
      else routeToJack(idx);
    }
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    el.sound.setAttribute("aria-pressed", state.soundOn ? "true" : "false");
    el.sound.innerHTML = state.soundOn ? "♪ On <kbd>M</kbd>" : "♪ Off <kbd>M</kbd>";
  }

  /* ——— resize ——— */
  function relayout() {
    layoutJacks();
    layoutHookAndPlug(false);
    sizeCanvas();
    // sync focus tabindexes on visible set
    const visible = jackBtns;
    visible.forEach((b, i) => { b.tabIndex = i === state.focusIdx ? 0 : -1; });
  }

  /* ——— boot ——— */
  async function boot() {
    el.app = document.getElementById("nx-app");
    el.stage = document.getElementById("nx-stage");
    el.shelf = document.getElementById("nx-shelf");
    el.hook = document.getElementById("nx-hook");
    el.plug = document.getElementById("nx-plug");
    el.canvas = document.getElementById("nx-cord");
    el.spark = document.getElementById("nx-spark");
    el.crt = document.getElementById("nx-crt");
    el.crtStatus = document.getElementById("nx-crt-status");
    el.crtTitle = document.getElementById("nx-crt-title");
    el.crtSub = document.getElementById("nx-crt-sub");
    el.lamp = document.getElementById("nx-lamp");
    el.ticket = document.getElementById("nx-ticket");
    el.ticketK = document.getElementById("nx-ticket-k");
    el.ticketTitle = document.getElementById("nx-ticket-title");
    el.ticketBody = document.getElementById("nx-ticket-body");
    el.hangup = document.getElementById("nx-hangup");
    el.live = document.getElementById("nx-live");
    el.sound = document.getElementById("nx-sound");
    el.jacksDesktop = document.getElementById("nx-jacks-desktop");
    el.jacksPhone = document.getElementById("nx-jacks-phone");

    ctx = el.canvas.getContext("2d");
    sctx = el.spark.getContext("2d");

    // plug is positioned in stage coords
    el.stage.style.position = "relative";
    el.plug.style.position = "absolute";
    // move plug under stage (not shelf) so coords match canvas
    el.stage.appendChild(el.plug);

    await mountAllStatic();
    await mountPlugPoses();
    await Promise.all([
      buildJacks(el.jacksDesktop, "desktop"),
      buildJacks(el.jacksPhone, "phone"),
      buildLabels(document.getElementById("nx-labels-desktop"), 2),
      buildLabels(document.getElementById("nx-labels-phone"), 2),
    ]);

    relayout();
    initRope();
    loop();

    el.plug.addEventListener("pointerdown", onPointerDown);
    el.plug.addEventListener("pointermove", onPointerMove);
    el.plug.addEventListener("pointerup", onPointerUp);
    el.plug.addEventListener("pointercancel", (e) => {
      if (state.press) { const pulled = !!state.scrub; state.press = null; state.pointerId = null; if (pulled) settleScrub(); return; } // cancel is never a click
      onPointerUp(e);
    });
    el.hangup.addEventListener("click", () => hangUp());
    el.sound.addEventListener("click", toggleSound);
    window.addEventListener("keydown", onGlobalKey);
    if (window.ResizeObserver) {
      new ResizeObserver(() => { clearTimeout(relayout._t); relayout._t = setTimeout(relayout, 30); }).observe(el.stage);
    }
    window.addEventListener("resize", () => {
      clearTimeout(relayout._t);
      relayout._t = setTimeout(relayout, 80);
    });

    // fonts ready then relayout once more
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => relayout());
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
