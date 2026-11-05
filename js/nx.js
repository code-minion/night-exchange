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
  };

  const el = {
    app: null, stage: null, shelf: null, hook: null, plug: null,
    canvas: null, crt: null, crtStatus: null, crtTitle: null, crtSub: null,
    lamp: null, ticket: null, ticketK: null, ticketTitle: null, ticketBody: null,
    hangup: null, live: null, sound: null,
    jacksDesktop: null, jacksPhone: null,
  };

  let ctx = null;
  let rope = null; // { pts: [{x,y,ox,oy}], pinned:0 }
  let plugPos = { x: 0, y: 0 };
  let hookPos = { x: 0, y: 0 };
  let jackCenters = []; // page coords for active board
  let jackBtns = []; // active buttons
  let allJackSets = { desktop: [], phone: [] };
  let lampSvg = null;
  let plugSvg = null;
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

  async function mountAllStatic() {
    const mounts = [
      ["board-strip", "board-strip-6"],
      ["board-grid", "board-grid-3x2"],
      ["lamp", "lamp"],
      ["plug", "plug"],
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
      if (key === "plug") {
        plugSvg = svg;
        svg.classList.add("nx-is-pulse");
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
    const board = activeBoard();
    const host = boardHostEl();
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const stageRect = el.stage.getBoundingClientRect();
    const stations = board === "strip" ? STRIP_STATIONS : GRID_STATIONS;
    const vb = board === "strip" ? STRIP_VB : GRID_VB;
    const sx = rect.width / vb.w;
    const sy = rect.height / vb.h;
    const btns = board === "strip" ? allJackSets.desktop : allJackSets.phone;
    jackBtns = btns;
    jackCenters = stations.map((s, i) => {
      const pageX = rect.left + s.x * sx;
      const pageY = rect.top + s.y * sy;
      const btn = btns[i];
      if (btn) {
        const localX = pageX - rect.left;
        const localY = pageY - rect.top;
        btn.style.left = `${localX}px`;
        btn.style.top = `${localY}px`;
        // size hit target
        const bore = board === "strip" ? 64 : Math.max(64, 72 * sx);
        btn.style.width = `${bore}px`;
        btn.style.height = `${bore}px`;
      }
      return {
        x: pageX - stageRect.left,
        y: pageY - stageRect.top,
        pageX,
        pageY,
      };
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
      const h = el.plug.offsetHeight || 78;
      // Boot rests on the hook; tip points up toward the board.
      plugPos = { x: hookPos.x, y: hookPos.y - h * 0.72 };
      placePlugEl();
      if (resetRope || !rope) initRope();
    } else if (state.connected != null && jackCenters[state.connected]) {
      const c = jackCenters[state.connected];
      plugPos = { x: c.x, y: c.y };
      placePlugEl();
      if (resetRope) initRopePinnedToJack();
    }
  }

  function placePlugEl() {
    el.plug.style.left = `${plugPos.x}px`;
    el.plug.style.top = `${plugPos.y}px`;
  }

  /** Cord exits the boot at the bottom of the plug SVG (~88% down). */
  function cordTip() {
    const h = el.plug.offsetHeight || 78;
    return { x: plugPos.x, y: plugPos.y + h * 0.72 };
  }

  function sizeCanvas() {
    const rect = el.stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.width = Math.floor(rect.width * dpr);
    el.canvas.height = Math.floor(rect.height * dpr);
    el.canvas.style.width = `${rect.width}px`;
    el.canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

  function loop() {
    verletStep(0.45, 3);
    drawCord();
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
    let best = -1;
    let bestD = radius;
    jackCenters.forEach((c, i) => {
      const d = hypot(c.x - x, c.y - y);
      if (d <= bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function markUsed() {
    if (state.used) return;
    state.used = true;
    if (plugSvg) plugSvg.classList.remove("nx-is-pulse");
  }

  async function seatInto(idx) {
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
      plugPos = { x: target.x, y: target.y };
      placePlugEl();
      finishConnect(idx);
      state.seating = false;
      return;
    }

    // last 6px in 70ms with 2px overshoot
    const from = { x: plugPos.x, y: plugPos.y };
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dist = hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    // pull to 6px out first if farther
    const approach = Math.max(0, dist - SEAT_DIST);
    const mid = {
      x: from.x + ux * approach,
      y: from.y + uy * approach,
    };
    plugPos = { ...mid };
    const over = {
      x: target.x + ux * OVERSHOOT,
      y: target.y + uy * OVERSHOOT,
    };

    await animatePlug(mid, over, SEAT_MS * 0.55);
    await animatePlug(over, { x: target.x, y: target.y }, SEAT_MS * 0.45);
    playStub("clack");
    if (navigator.vibrate) {
      try { navigator.vibrate(15); } catch (_) {}
    }
    finishConnect(idx);
    state.seating = false;
  }

  function animatePlug(from, to, ms) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      function step(now) {
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
    el.ticket.hidden = false;
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
    setJackLit(-1, 0);
    state.connected = null;
    await animateLamp(1, 0, reduceMotion ? 0 : 80, "nx-is-off");
  }

  async function hangUp() {
    if (state.connected == null && !state.dragging) {
      // swing back if mid-air
    }
    const fromIdx = state.connected;
    state.connected = null;
    state.magnetIdx = -1;
    setJackLit(-1, 0);

    el.ticket.classList.remove("is-open");
    setTimeout(() => { el.ticket.hidden = true; }, 400);

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
      {
        const h = el.plug.offsetHeight || 78;
        plugPos = { x: hookPos.x, y: hookPos.y - h * 0.72 };
      }
      placePlugEl();
      initRope();
    } else {
      // swing back
      const h = el.plug.offsetHeight || 78;
      await animatePlug(plugPos, { x: hookPos.x, y: hookPos.y - h * 0.72 }, 520);
      // give rope leftover velocity for settle
      if (rope) {
        const tip = rope.pts[rope.pts.length - 1];
        tip.ox = tip.x - 4;
        tip.oy = tip.y + 2;
      }
    }

    if (fromIdx != null && jackBtns[fromIdx]) {
      jackBtns[fromIdx].focus();
    } else {
      el.plug.focus();
    }
  }

  async function routeToJack(idx) {
    if (state.routing) return;
    state.routing = true;
    markUsed();

    if (state.connected != null && state.connected !== idx) {
      await softDisconnect();
    }

    const target = jackCenters[idx];
    if (!target) { state.routing = false; return; }

    if (reduceMotion) {
      plugPos = { x: target.x, y: target.y };
      placePlugEl();
      playStub("clack");
      finishConnect(idx);
      state.routing = false;
      return;
    }

    // route ~450ms from hook/current to near jack, then seat
    const start = { x: plugPos.x, y: plugPos.y };
    const approach = {
      x: target.x,
      y: target.y - SEAT_DIST,
    };
    // slight arc
    await new Promise((resolve) => {
      const t0 = performance.now();
      function step(now) {
        const t = Math.min(1, (now - t0) / ROUTE_MS);
        const e = 1 - Math.pow(1 - t, 2);
        plugPos.x = start.x + (approach.x - start.x) * e;
        plugPos.y = start.y + (approach.y - start.y) * e - Math.sin(t * Math.PI) * 40;
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
    state.routing = false;
    await seatInto(idx);
  }

  function onJackActivate(idx) {
    if (state.dragging || state.seating) return;
    if (state.connected === idx) {
      hangUp();
      return;
    }
    if (isPhoneLayout()) {
      routeToJack(idx);
    } else {
      // desktop: clicking jack also connects (keyboard/Enter path shares this)
      routeToJack(idx);
    }
  }

  /* ——— pointer drag ——— */
  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    markUsed();
    state.dragging = true;
    state.pointerId = e.pointerId;
    el.plug.setPointerCapture(e.pointerId);
    // if connected, unplug first
    if (state.connected != null) {
      const idx = state.connected;
      state.connected = null;
      setJackLit(-1, 0);
      el.ticket.classList.remove("is-open");
      el.crt.classList.remove("is-resolved", "is-resolving");
      animateLamp(1, 0, 100, "nx-is-off");
      el.crtStatus.textContent = "> STANDBY · PICK UP THE RED CORD";
      el.crtTitle.textContent = "GOOD EVENING.";
      el.crtSub.textContent = "PATCH A LINE TO BEGIN_";
    }
  }

  function onPointerMove(e) {
    if (!state.dragging || e.pointerId !== state.pointerId) return;
    const stageRect = el.stage.getBoundingClientRect();
    plugPos.x = e.clientX - stageRect.left;
    plugPos.y = e.clientY - stageRect.top;
    const snapR = (e.pointerType === "touch") ? TOUCH_SNAP : DESKTOP_SNAP;
    const near = nearestJack(plugPos.x, plugPos.y, MAGNET_PULL);
    if (near >= 0) {
      state.magnetIdx = near;
      setJackLit(near, 0.45);
      // slight magnetic pull
      const c = jackCenters[near];
      const d = hypot(c.x - plugPos.x, c.y - plugPos.y);
      if (d > 0 && d < MAGNET_PULL) {
        const pull = (1 - d / MAGNET_PULL) * 0.18;
        plugPos.x += (c.x - plugPos.x) * pull;
        plugPos.y += (c.y - plugPos.y) * pull;
      }
    } else if (state.magnetIdx >= 0) {
      state.magnetIdx = -1;
      setJackLit(-1, 0);
    }
  }

  async function onPointerUp(e) {
    if (!state.dragging || e.pointerId !== state.pointerId) return;
    state.dragging = false;
    state.pointerId = null;
    const snapR = (e.pointerType === "touch") ? TOUCH_SNAP : DESKTOP_SNAP;
    const near = nearestJack(plugPos.x, plugPos.y, snapR);
    if (near >= 0) {
      await seatInto(near);
    } else {
      setJackLit(-1, 0);
      // swing back to hook
      {
        const h = el.plug.offsetHeight || 78;
        const home = { x: hookPos.x, y: hookPos.y - h * 0.72 };
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
      if (e.target.closest("input,textarea,button.nx-hangup")) return;
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

    // plug is positioned in stage coords
    el.stage.style.position = "relative";
    el.plug.style.position = "absolute";
    // move plug under stage (not shelf) so coords match canvas
    el.stage.appendChild(el.plug);

    await mountAllStatic();
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
    el.plug.addEventListener("pointercancel", onPointerUp);
    el.hangup.addEventListener("click", () => hangUp());
    el.sound.addEventListener("click", toggleSound);
    window.addEventListener("keydown", onGlobalKey);
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
