/* Night Exchange P1 — authoritative geometry, plug pose contract and arc state machine.
   Pure functions, no DOM. Loaded in the page as a classic script (globalThis.NXGeo) and in
   Node tests via vm. Placement, hit tests, cord endpoint, seating, drag and arc all read here.

   World frame = stage CSS px. The plug's state is R: the world position of the sprite's
   socket reference. Seated ⇔ R == socketRef(centre). */
(function (root) {
  "use strict";

  // VE board art: viewBox + station hole centres (assets README).
  const BOARDS = {
    strip: { vb: { w: 760, h: 158 }, stations: [[108, 62], [217, 62], [326, 62], [435, 62], [544, 62], [653, 62]],
             seatR: 32, boreR: 26, cols: 6, jackPerBoardPx: 84 / 760 },  // J84 on a 760 board (insertion-v2 README)
    grid:  { vb: { w: 390, h: 312 }, stations: [[77, 74], [195, 74], [313, 74], [77, 188], [195, 188], [313, 188]],
             seatR: 44, boreR: 36, cols: 3, jackPerBoardPx: 116 / 390 }, // J116 on a 390 board
  };

  // jack.svg: viewBox 80×80, bore (40,40); flange ≈ 0.8·J.
  const JACK = { vb: 80, bore: { x: 40, y: 40 }, flangeRatio: 0.8 };

  // ——— Plug art ———
  // DEFAULT / DRAG / TAP-ROUTE plug = Visual Engineer's original upright plug.svg (viewBox 88×156, tip up, no cord),
  // drawn at 1.5× P1's size: 66×117 CSS px (k = 0.75 px/unit). R (plug position) is P1's hold point: placed like P1's
  // `translate(-50%,-12%)`, i.e. sprite point (44, 18.72) sits on R. The cord leaves the boot at P1's anchor
  // 0.72·117 = 84.24px below R. tip = the apex of the brass tip, path "M39 16c0-8 10-8 10 0" → (44, 10).
  const ORIGINAL = {
    file: "svg/plug.svg", vb: { w: 88, h: 156 }, box: { w: 66, h: 117 }, k: 0.75,
    hold: { x: 44, y: 18.72 }, tip: { x: 44, y: 10 }, cordPx: 84.24,
    bodyHalfW: 18, bodyBelowTip: 99, // silhouette for route clearance: grip is 48 units wide; art runs to y=142 units
  };
  // PLUGGED-IN state = production-B2 sprite sheet (14 frames, 240×340 px @2x = 120×170 CSS each), socket ref S=(60,62)
  // placed on the jack's black-core centre. The tip apex is on S in every frame. Sheet times / cord exits are
  // production-B2 sheet.json + anchors.json (CSS px; cord exit is +y below S, x is always 0).
  const SHEET = {
    file: "img/sheet.webp", frames: 14, canvas: { w: 120, h: 170 }, S: { x: 60, y: 62 },
    ms: [0, 17, 33, 50, 67, 83, 100, 117, 133, 150, 167, 183, 200, 210],
    cordY: [90.75, 90.39, 90.64, 91.23, 92.33, 92.98, 90.6, 81.5, 65.62, 47.2, 30.65, 18.61, 11.89, 10.84],
    tipVisibleThrough: 9,            // anchors.json tip_visible: true for f00–f09, false f10–f13
    head: { r: 18.5 },               // end-on seated head 37px across, centred on S (measured on f13)
    bounce: { scale: 1.04, ms: 50 }, // CSS only, after f13, origin = S, no translate
  };
  SHEET.seatMs = SHEET.ms[SHEET.frames - 1]; // 210
  // Seat/unseat = frames 0→13 over 210ms / 13→0 over the same intervals. nx.js swapPlug() is the single place that plays them.
  const POSE = { ORIGINAL: 0, SHEET: 2 };
  const FINAL = { ms: 70 };      // final approach: tip decelerates to rest on the socket in the last 70ms
  // Drag-out from seated: pulling the head scrubs f13→f00 over the first 40 CSS px; past that the upright plug follows the finger.
  const SCRUB = { px: 40, slop: 6 };
  function scrubFrac(pull) { return Math.min(1, Math.max(0, pull / SCRUB.px)); }
  function scrubFrame(pull) { return sheetFrameReverse(scrubFrac(pull) * SHEET.seatMs); }
  function scrubSettleMs(pull) { return scrubFrac(pull) * SHEET.seatMs; } // released early: frames run back to f13 at 1ms/ms
  /** Forward playback: frame shown at t ms after the swap trigger (f13 from 210ms). */
  function sheetFrame(t) { let f = 0; for (let i = 0; i < SHEET.frames; i++) if (SHEET.ms[i] <= t) f = i; return f; }
  /** Reverse playback (hang-up): the same intervals backwards; f13 holds 10ms, then f12, … f00 at 210ms. */
  function sheetFrameReverse(r) { const t = SHEET.seatMs - r; for (let i = 0; i < SHEET.frames; i++) if (SHEET.ms[i] >= t) return i; return SHEET.frames - 1; }
  const MIN_TARGET = 64;
  const ARC = { enter: 16, rearm: 24, durationMs: 80 };

  function boardScale(kind, hostWidth) { return hostWidth / BOARDS[kind].vb.w; }
  function jackSize(kind, hostWidth) { return BOARDS[kind].jackPerBoardPx * hostWidth; }
  function unit(J) { return J / 80; } // CSS px per jack/plug viewBox unit
  /** World point the plug reference must reach when seated: the black core centre (station centre + 0.4 unit). */
  function socketRef(center, J) { return { x: center.x, y: center.y + 0.4 * unit(J) }; }

  function socketCenters(kind, hostLeft, hostTop, hostWidth) {
    const b = BOARDS[kind], s = boardScale(kind, hostWidth);
    return b.stations.map(([x, y], i) => ({ i, x: hostLeft + x * s, y: hostTop + y * s, boreR: b.boreR * s, seatR: b.seatR * s }));
  }
  function jackBox(kind, center, hostWidth) {
    const J = jackSize(kind, hostWidth), k = unit(J);
    return { left: center.x - JACK.bore.x * k, top: center.y - JACK.bore.y * k, width: J, height: J, flange: JACK.flangeRatio * J };
  }
  function hitBox(center) {
    const d = Math.max(MIN_TARGET, center.boreR * 2);
    return { left: center.x - d / 2, top: center.y - d / 2, width: d, height: d };
  }


  /** What to draw for (R, pose, frame): exactly one plug art. Original: 66×117 box, P1 placement. Sheet: the 120×170
      frame placed so S sits on R (== socketRef), cord at that frame's cord exit. */
  function display(R, J, pose, frame) {
    if (pose === POSE.SHEET) {
      const f = frame | 0, o = { x: R.x - SHEET.S.x, y: R.y - SHEET.S.y };
      return { frame: 1, sheetFrame: f, origin: o, width: SHEET.canvas.w, height: SHEET.canvas.h,
        cord: { x: R.x, y: R.y + SHEET.cordY[f] },
        grip: { x: R.x, y: R.y, rx: SHEET.head.r, ry: SHEET.head.r, round: true }, tip: null };
    }
    const w = ORIGINAL.box.w, h = ORIGINAL.box.h, o = { x: R.x - ORIGINAL.hold.x * ORIGINAL.k, y: R.y - ORIGINAL.hold.y * ORIGINAL.k };
    return { frame: 0, origin: o, width: w, height: h, cord: { x: R.x, y: R.y + ORIGINAL.cordPx },
      grip: { x: o.x + w / 2, y: o.y + h / 2, rx: w / 2, ry: h / 2, round: false }, tip: tipWorld(R, POSE.ORIGINAL) };
  }
  function cordWorld(R, J, pose, frame) { return display(R, J, pose, frame).cord; }
  /** Visible brass tip of the ORIGINAL plug (null once seated). */
  function tipWorld(R, pose) {
    if (pose === POSE.SHEET) return null;
    return { x: R.x + (ORIGINAL.tip.x - ORIGINAL.hold.x) * ORIGINAL.k, y: R.y + (ORIGINAL.tip.y - ORIGINAL.hold.y) * ORIGINAL.k };
  }
  function refFromTip(tip) { return { x: tip.x - (ORIGINAL.tip.x - ORIGINAL.hold.x) * ORIGINAL.k, y: tip.y - (ORIGINAL.tip.y - ORIGINAL.hold.y) * ORIGINAL.k }; }
  /** Rest on hook: P1 puts the cord anchor on the hook point. */
  function restRef(hook) { return { x: hook.x, y: hook.y - ORIGINAL.cordPx }; }

  /* ——— Trajectories (world px; socket = socketRef of the target) ———
     The original plug's visible TIP is routed: it ends on the socket reference at contactAt (= 450ms route + 70ms
     seat) with constant deceleration d(T) = b·T² (T = ms to contact), so it arrives at rest, coming from below
     (the tip points up). At contact nx.js swapPlug() plays the B2 sheet. */
  // Tap/keyboard travel is 300ms and ends exactly at tip-touch: an ease-out (fast launch, Hermite) into the constant-
  // deceleration final approach d = b·T² over the last gateT ms, so the tip arrives at rest. Then the 210ms frames.
  const TRAJ = { routeMs: 300, b: 0.0018, gateT: 120, launch: 1.5, launches: [1.5, 1.25, 1], minArcPx: 1 };
  TRAJ.contactAt = TRAJ.routeMs; // tip-touch; f00 starts here (total 300 + 210 = 510ms)

  function routeTip(S, socket, plan, t) {
    const gateAt = TRAJ.contactAt - TRAJ.gateT, dir = plan.dir;
    t = Math.min(TRAJ.contactAt, Math.max(0, t));
    if (t >= gateAt) { const T = TRAJ.contactAt - t, d = TRAJ.b * T * T; return { x: socket.x + dir.x * d, y: socket.y + dir.y * d }; }
    const dg = TRAJ.b * TRAJ.gateT ** 2, A = { x: socket.x + dir.x * dg, y: socket.y + dir.y * dg };
    const sp = 2 * TRAJ.b * TRAJ.gateT, v1 = { x: -dir.x * sp, y: -dir.y * sp };
    const s = t / gateAt, s2 = s * s, s3 = s2 * s, D = gateAt;
    const h00 = 2 * s3 - 3 * s2 + 1, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2, h10 = s3 - 2 * s2 + s, bulge = Math.sin(Math.PI * s) ** 2;
    const L = plan.launch == null ? TRAJ.launch : plan.launch, m0x = L * (A.x - S.x), m0y = L * (A.y - S.y); // launch speed 1.5× the mean: ease-out, not ease-in
    return { x: h00 * S.x + h10 * m0x + h01 * A.x + h11 * D * v1.x + plan.swing * bulge, y: h00 * S.y + h10 * m0y + h01 * A.y + h11 * D * v1.y + (plan.dip || 0) * bulge };
  }
  /** Distance from point o to the upright plug silhouette whose tip is at `tip` (rect below the tip, tip rounded off). */
  function bodyDist(o, tip) {
    const dx = Math.max(Math.abs(o.x - tip.x) - ORIGINAL.bodyHalfW, 0);
    const dy = o.y < tip.y ? tip.y - o.y : (o.y > tip.y + ORIGINAL.bodyBelowTip ? o.y - tip.y - ORIGINAL.bodyBelowTip : 0);
    return Math.hypot(dx, dy);
  }
  /** Route margins vs the other sockets' wood recesses (seatR): tip-only, whole plug during transit (before the final
      approach), and whole plug over the entire route. Negative = overlap, in px. */
  function routeMargins(S, socket, plan, others) {
    const gateAt = TRAJ.contactAt - TRAJ.gateT; let tip = Infinity, transit = Infinity, all = Infinity;
    for (let t = 0; t <= TRAJ.contactAt; t += 2) {
      const p = routeTip(S, socket, plan, t);
      for (const o of others) {
        const r = o.seatR || 2 * ARC.rearm, b = bodyDist(o, p) - r;
        tip = Math.min(tip, Math.hypot(p.x - o.x, p.y - o.y) - r); all = Math.min(all, b); if (t < gateAt) transit = Math.min(transit, b);
      }
    }
    return { tip, transit, all };
  }
  function planClearance(S, socket, plan, others) {
    const gateAt = TRAJ.contactAt - TRAJ.gateT; let other = Infinity, tip = Infinity, target = Infinity;
    for (let t = 0; t <= TRAJ.contactAt; t += 2) {
      const p = routeTip(S, socket, plan, t);
      if (t < gateAt) for (const o of others) {
        const r = o.seatR || 2 * ARC.rearm;
        other = Math.min(other, bodyDist(o, p) - r);               // the whole upright plug while in transit
        tip = Math.min(tip, Math.hypot(p.x - o.x, p.y - o.y) - r); // the visible tip alone
      }
      if (t < gateAt) target = Math.min(target, Math.hypot(p.x - socket.x, p.y - socket.y));
    }
    return { other, tip, target };
  }
  /** Pick a transit: (1) whole plug clear of every other recess; else (2) tip clear, widest whole-plug margin
      (a 36px plug cannot fit the 30px gaps between phone recesses); else (3) best tip margin. */
  function planRoute(S, socket, others) {
    const keep = TRAJ.b * TRAJ.gateT ** 2 - 4; // before the final approach the tip stays outside the gate point
    others = (others || []).filter((o) => Math.hypot(o.x - S.x, o.y - S.y) > 2 * ARC.rearm); // departing socket isn't an obstacle
    const side = S.x < socket.x ? -1 : 1, a = Math.PI / 6;
    const dirs = [{ x: 0, y: 1 }, { x: Math.sin(a) * side * -1, y: Math.cos(a) }, { x: Math.sin(a) * side, y: Math.cos(a) }]; // from below, tip pointing up
    const swings = [0, side * 50, side * 90, -side * 50, -side * 90];
    let t2 = null, t3 = null;
    for (const launch of TRAJ.launches) for (const dip of [0, 30, 60, 90]) for (const dir of dirs) for (const swing of swings) {
      const plan = { dir, swing, dip, launch }, c = planClearance(S, socket, plan, others);
      if (c.target < keep) { const sc = c.tip - (keep - c.target); if (!t3 || sc > t3.sc) t3 = { plan: Object.assign(plan, { clearance: c }), sc }; continue; }
      if (c.other >= 0) return Object.assign(plan, { clearance: c });
      if (c.tip >= 0 && (!t2 || c.other > t2.o)) t2 = { plan: Object.assign(plan, { clearance: c }), o: c.other };
      if (!t3 || c.tip > t3.sc) t3 = { plan: Object.assign(plan, { clearance: c }), sc: c.tip };
    }
    return (t2 || t3).plan;
  }
  /** Auto-route (tap + keyboard) at t∈[0,520]: the original plug's tip to the socket; seated pose at contact. */
  function routeFrame(S, socket, J, t, plan) {
    plan = plan || planRoute(S, socket, []);
    if (t < TRAJ.contactAt) { const tip = routeTip(S, socket, plan, t); return { R: refFromTip(tip), pose: POSE.ORIGINAL, tip, contact: false }; }
    return { R: { x: socket.x, y: socket.y }, pose: POSE.SHEET, tip: null, contact: true };
  }
  /** Drag-release seat at ms∈[0,70]: tip closes v0 (tip − socket) to rest on the socket, then seated. */
  const CLOSE_MS = FINAL.ms;
  function dragSeatFrame(socket, J, v0, ms) {
    if (ms < CLOSE_MS) { const f = ((CLOSE_MS - ms) / CLOSE_MS) ** 2, tip = { x: socket.x + v0.x * f, y: socket.y + v0.y * f };
      return { R: refFromTip(tip), pose: POSE.ORIGINAL, tip, contact: false }; }
    return { R: { x: socket.x, y: socket.y }, pose: POSE.SHEET, tip: null, contact: true };
  }

  function nearest(centers, pt, radius) {
    let best = -1, bd = radius;
    for (const c of centers) { const d = Math.hypot(c.x - pt.x, c.y - pt.y); if (d <= bd) { bd = d; best = c.i; } }
    return best;
  }

  /** One-shot arc on ACTUAL tip distance: fire on entering <= enter, last durationMs, cut on contact,
      rearm only beyond rearm. dist = Infinity when tip is buried. Reduced motion: never. */
  function createArc(opts) {
    const o = Object.assign({}, ARC, opts || {});
    let armed = true, until = 0, target = -1, fires = 0;
    return {
      update(dist, socketIdx, contact, now, reduced) {
        if (reduced) { until = 0; return false; }
        if (contact) { until = 0; armed = false; return false; }
        if (dist > o.rearm) armed = true;
        if (armed && dist <= o.enter) { armed = false; until = now + o.durationMs; target = socketIdx; fires++; }
        return now < until;
      },
      reset() { armed = true; until = 0; },
      get target() { return target; }, get fires() { return fires; }, get armed() { return armed; },
    };
  }

  root.NXGeo = { BOARDS, JACK, ORIGINAL, SHEET, POSE, FINAL, sheetFrame, sheetFrameReverse, SCRUB, scrubFrac, scrubFrame, scrubSettleMs, bodyDist, routeMargins, TRAJ, CLOSE_MS, MIN_TARGET, ARC, boardScale, jackSize, unit, socketRef,
    socketCenters, jackBox, hitBox, tipWorld, refFromTip, display, cordWorld, restRef, routeTip, planRoute, routeFrame, dragSeatFrame,
    nearest, createArc };
})(typeof globalThis !== "undefined" ? globalThis : this);
