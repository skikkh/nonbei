/* 東京のんべえ地図 — 30-second vertical reel, rendered frame by frame.
 *
 * The page shows the real map (site/src/atlas.js with the site's data) and
 * lays seven scenes over it. reel.seek(t) puts the camera and every overlay
 * where they belong at t seconds, so promo/capture.js can step through
 * the frames one by one and wait for the map to finish drawing each one.
 */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const KIND = {
    yokocho: ["横丁", "横", "#ff6a4a"], senbero: ["せんべろ", "千", "#f5b844"], tachinomi: ["立ち飲み", "立", "#7aa2ff"],
    kakuuchi: ["角打ち", "角", "#52c9a0"], bar: ["バー", "酒", "#b892f2"], social: ["交流酒場", "交", "#ff7fae"],
  };
  const NUM = ["一", "二", "三", "四", "五", "六", "七"];
  const CUTS = [13, 17.4, 21.6];
  const FRIDAY = Date.UTC(2026, 9, 9, 0, 0) - 9 * 3600e3;   // 2026-10-09 00:00 JST
  const SHOW = { card: "nippori-yomo-saketen", hop: ["akabane-ikoi-honten", "akabane-maruken-suisan", "akabane-marumasuya"],
    alley: ["shinjuku-golden-gai", "shinjuku-omoide-yokocho"] };

  // [t, lng, lat, zoom, pitch, bearing, bottom padding]; equal times are cuts
  const CAM = [
    [0.0, 139.742, 35.693, 10.3, 0, 0, 0],
    [4.4, 139.745, 35.697, 11.25, 32, -10, 0],
    [7.7, 139.726, 35.696, 12.5, 44, -18, 0],
    [9.0, 139.7058, 35.6935, 15.7, 54, -26, 0],
    [13.0, 139.7056, 35.6934, 16.5, 60, 14, 0],
    [13.0, 139.77722, 35.72860, 16.9, 56, -38, 430],
    [17.4, 139.77722, 35.72860, 17.5, 60, 6, 430],
    [17.4, 139.752, 35.700, 11.95, 34, -12, 0],
    [21.6, 139.752, 35.701, 12.35, 40, -2, 0],
    [21.6, 139.72125, 35.77915, 16.65, 50, -32, 60],
    [25.8, 139.72125, 35.77920, 17.05, 56, -16, 60],
    [27.7, 139.742, 35.712, 11.7, 22, 0, 0],
    [30.0, 139.745, 35.700, 11.15, 8, 0, 0],
  ];

  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);
  const lerp = (a, b, u) => a + (b - a) * u;
  const merc = (lng, lat) => NBAtlas.fromLngLat(lng, lat);
  const unmerc = (x, y) => NBAtlas.toLngLat(x, y);

  function camAt(t) {
    let i = 0;
    while (i < CAM.length - 2 && (CAM[i + 1][0] <= t)) i++;
    let a = CAM[i], b = CAM[i + 1];
    if (b[0] === a[0]) { a = b; b = CAM[i + 2] || b; }
    const u = b[0] > a[0] ? clamp((t - a[0]) / (b[0] - a[0])) : 1;
    const e = ease(u);
    const z = lerp(a[3], b[3], e);
    // move the centre in step with the change of scale, so long pulls read as one steady motion
    let f = e;
    if (Math.abs(b[3] - a[3]) > 1.5) f = (Math.pow(2, -z) - Math.pow(2, -a[3])) / (Math.pow(2, -b[3]) - Math.pow(2, -a[3]));
    const [ax, ay] = merc(a[1], a[2]), [bx, by] = merc(b[1], b[2]);
    const c = unmerc(lerp(ax, bx, f), lerp(ay, by, f));
    return { center: c, zoom: z, pitch: lerp(a[4], b[4], e), bearing: lerp(a[5], b[5], e), padding: { top: 0, left: 0, right: 0, bottom: lerp(a[6], b[6], e) } };
  }

  // ------------------------------------------------------------------ open-now (same rules as the site)
  const HOL = new Set(["2026-10-12", "2026-11-03", "2026-11-23"]);
  const DK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  function rangesFor(w, t) {
    const key = ymd(t), dow = new Date(t).getUTCDay();
    if (HOL.has(key) && w.hol !== undefined) return w.hol;
    if (HOL.has(ymd(t + 864e5)) && w.prehol !== undefined) return w.prehol;
    return w[DK[dow]];
  }
  function isOpen(s, now) {
    if (!s.week) return false;
    const t = now + 9 * 3600e3, min = new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes();
    for (const [, c] of rangesFor(s.week, t - 864e5) || []) if (c > 1440 && min + 1440 < c) return true;
    for (const [o, c] of rangesFor(s.week, t) || []) if (min >= o && min < c) return true;
    return false;
  }

  // ------------------------------------------------------------------ setup
  let D, live, byId, atlas, lastOpenKey = null, sel = null;
  const ready = (async () => {
    D = await fetch("../data/spots.json").then((r) => r.json());
    live = D.spots.filter((s) => s.status !== "closed");
    byId = Object.fromEntries(D.spots.map((s) => [s.id, s]));
    fill();
    await new Promise((res) => {
      atlas = new NBAtlas.Atlas($("#map"), {
        spots: live, chunks: D.chunks, theme: "night", three: true, capture: true, webSans: true, dataUrl: "../data/",
        bounds: [[139.6, 35.6], [139.9, 35.8]], padding: () => 0, showPoi: () => false, onReady: res,
      });
    });
    window.nbAtlas = atlas;
    const m = atlas.map;
    m.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    m.addLayer({ id: "route-glow", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#f5b844", "line-width": 12, "line-blur": 8, "line-opacity": 0.45 } }, "anchor-spots");
    m.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffd27a", "line-width": 3.2, "line-dasharray": [0.2, 1.8] } }, "anchor-spots");
    const text = document.body.innerText + live.map((s) => s.name).join("");
    await Promise.all([
      document.fonts.load('800 38px "Shippori Mincho B1"', text), document.fonts.load('600 16px "Shippori Mincho B1"', text),
      document.fonts.load('400 15px "BIZ UDPGothic"', text), document.fonts.load('700 15px "BIZ UDPGothic"', text),
    ]);
    await document.fonts.ready;
    // the atlas loads its own label fonts; wait for them
    for (let i = 0; i < 200 && !atlas.fontsReady; i++) await new Promise((r) => setTimeout(r, 50));
  })();

  function fill() {
    const counts = {};
    live.forEach((s) => { counts[s.kind] = (counts[s.kind] || 0) + 1; });
    document.querySelectorAll('[data-n="all"]').forEach((el) => { el.textContent = live.length; });
    $("#seals").innerHTML = Object.entries(KIND).map(([k, [label, g, c]], i) =>
      `<li data-d="${0.5 + i * 0.16}"><i class="seal" style="--c:${c}">${g}</i>${label}<b>${counts[k] || 0}<small>軒</small></b></li>`).join("");
    const [gg, om] = SHOW.alley.map((id) => byId[id]);
    $("#s3cap").innerHTML = `<span class="row" data-d="0.5"><b>${gg.name}</b>${gg.catch || ""}</span>` +
      `<span class="row" data-d="0.8"><b>${om.name.replace("新宿西口 ", "")}</b>戦後の闇市から続く、焼き鳥ともつ焼きの路地</span>`;
    const s = byId[SHOW.card];
    const menu = (s.menu || []).filter((m) => m.p).slice(0, 4);
    const rules = (s.rules || []).slice(0, 2);
    $("#card").innerHTML = `<p class="k"><i class="seal" style="--c:${KIND[s.kind][2]}">${KIND[s.kind][1]}</i>${KIND[s.kind][0]}・${s.area}</p>
      <h3><ruby>${s.name.replace(/（.*?）/, "")}<rt>${s.kana || ""}</rt></ruby></h3>
      ${s.catch ? `<p class="catch">${s.catch}</p>` : ""}
      <h4 data-d="0.6">品書き</h4><ul class="menu">${menu.map((m, i) => `<li data-d="${0.75 + i * 0.16}"><span>${m.n}</span><i></i><span>${m.p}</span></li>`).join("")}</ul>
      <h4 data-d="1.5">店の決まり</h4><ul class="rules">${rules.map((r, i) => `<li data-d="${1.65 + i * 0.2}">${r}</li>`).join("")}</ul>`;
    $("#stops").innerHTML = SHOW.hop.map((id, i) => {
      const o = byId[id];
      return `<div class="stop" data-stop="${i}"><small>${NUM[i]}軒目</small><b>${o.name.replace(/^(立ち飲み|大衆酒場|鯉とうなぎの)\s*/, "").replace(/\s*総本店$/, "")}</b><span>${o.catch || ""}</span></div>`;
    }).join("") + SHOW.hop.slice(1).map((id, i) => `<div class="walk" data-walk="${i}">徒歩${walkMin(byId[SHOW.hop[i]], byId[id])}分</div>`).join("");
  }
  function dist(a, b) {
    const R = 6371e3, r = Math.PI / 180;
    const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const walkMin = (a, b) => Math.max(1, Math.round(dist(a, b) * 1.2 / 80));

  // ------------------------------------------------------------------ one frame
  function seek(t) {
    const m = atlas.map;
    const cam = camAt(t);
    m.jumpTo(cam);
    // scene overlays
    let scene = 0;
    document.querySelectorAll(".sc").forEach((el, i) => {
      const a = +el.dataset.a, b = +el.dataset.b;
      const local = t - a;
      const fin = i === 0 ? clamp(local / 0.7 + 0.15) : clamp(local / 0.45);
      const vis = fin * clamp((b - t) / 0.35);
      el.style.opacity = vis.toFixed(3);
      if (t >= a && t < b) scene = i;
      const h = el.querySelector(".v");
      if (h) h.style.transform = (el.classList.contains("s7") ? "translateX(-50%) " : "") + `translateY(${((1 - easeOut(clamp(local / 0.7))) * 16).toFixed(2)}px)`;
      el.querySelectorAll("[data-d]").forEach((c) => {
        const u = clamp((local - +c.dataset.d) / 0.4);
        c.style.opacity = u.toFixed(3);
        c.style.transform = `translateY(${((1 - easeOut(u)) * 10).toFixed(2)}px)`;
      });
    });
    $("#count").textContent = `${NUM[scene]}　／　七`;
    // cut dips
    let dip = 0;
    for (const c of CUTS) dip = Math.max(dip, 1 - Math.abs(t - c) / 0.24);
    $("#dip").style.opacity = clamp(dip).toFixed(3);
    $("#veil").style.opacity = (clamp((t - 25.9) / 0.8) * 0.85).toFixed(3);

    // scene 4: the featured shop is selected
    // scene 5: the clock runs through a Friday and only open shops stay lit
    let want = null, select = null;
    if (t >= 13 && t < 17.4) select = SHOW.card;
    if (t >= 17.4 && t < 21.6) {
      const u = clamp((t - 17.75) / 3.4);
      const mins = 15 * 60 + Math.round(u * 9 * 6) * 10;   // 15:00 → 24:00 in 10-minute steps
      const now = FRIDAY + mins * 60e3;
      const ids = live.filter((s) => isOpen(s, now)).map((s) => s.id);
      want = ids;
      $("#clk-d").textContent = "金曜日";
      $("#clk-t").textContent = mins >= 1440 ? "24:00" : `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
      $("#clk-n").textContent = ids.length;
    }
    const key = want ? want.join(",") : "all";
    if (key !== lastOpenKey) { atlas.setVisible(want || live.map((s) => s.id)); lastOpenKey = key; }
    // scene 6: a dotted walk from shop to shop
    const hop = SHOW.hop.map((id) => byId[id]);
    let coords = [];
    let reached = -1;
    if (t >= 21.6 && t < 26) {
      const u = clamp((t - 22.3) / 2.4);
      const legs = [dist(hop[0], hop[1]), dist(hop[1], hop[2])];
      const total = legs[0] + legs[1];
      let d = u * total;
      coords = [[hop[0].lng, hop[0].lat]];
      reached = 0;
      for (let i = 0; i < 2; i++) {
        const f = clamp(d / legs[i]);
        const a = hop[i], b = hop[i + 1];
        coords.push([lerp(a.lng, b.lng, f), lerp(a.lat, b.lat, f)]);
        if (f >= 1) reached = i + 1;
        d -= legs[i];
        if (f < 1) break;
      }
      select = hop[Math.max(0, reached)].id;
    }
    m.getSource("route").setData({ type: "FeatureCollection", features: coords.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] : [] });
    if (select !== sel) { atlas.select(select); sel = select; }
    // labels that follow the map
    document.querySelectorAll(".stop").forEach((el) => {
      const i = +el.dataset.stop, s = hop[i], p = m.project([s.lng, s.lat]);
      const on = reached >= i ? clamp((t - 22.3 - i * 1.15) / 0.35 + 1) : 0;
      el.style.left = `${clamp(p.x, 130, 410)}px`; el.style.top = `${p.y - 30}px`;
      el.style.opacity = (i === 0 ? clamp((t - 22.0) / 0.35) : on).toFixed(3);
    });
    document.querySelectorAll(".walk").forEach((el) => {
      const i = +el.dataset.walk, a = m.project([hop[i].lng, hop[i].lat]), b = m.project([hop[i + 1].lng, hop[i + 1].lat]);
      el.style.left = `${(a.x + b.x) / 2 + (i ? 52 : -6)}px`; el.style.top = `${(a.y + b.y) / 2 + (i ? 26 : 8)}px`;
      el.style.opacity = (reached > i ? 1 : 0).toFixed(3);
    });
  }

  async function settled() {
    const m = atlas.map;
    for (let i = 0; i < 400; i++) {
      const busy = Object.values(atlas.chunks).some((c) => c.state === "loading") || atlas.hiState === "loading";
      if (!busy && m.loaded() && m.areTilesLoaded() && !m.isMoving()) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  window.reel = { ready: () => ready, seek, settled, T: 30, FPS: 30 };
})();
