/* 東京のんべえ地図 — UI: filters, list, detail, markers. Data: window.NB_DATA */
(() => {
  "use strict";

  const D = window.NB_DATA;
  const CFG = window.NB_CONFIG || {};
  const SPOTS = D.spots;
  const BYID = new Map(SPOTS.map((s) => [s.id, s]));
  const KIND = {
    yokocho: { label: "横丁", g: "横", note: "飲み屋横丁・ガード下・飲食街" },
    senbero: { label: "センベロ", g: "千", note: "千〜二千円で酔える大衆酒場" },
    tachinomi: { label: "立ち飲み", g: "立", note: "立って飲む店。隣との距離が近い" },
    kakuuchi: { label: "角打ち", g: "角", note: "酒屋の店先で飲む" },
    bar: { label: "バー・スナック", g: "酒", note: "店主や常連と話せる小さな店" },
    social: { label: "交流型", g: "話", note: "交流そのものが売りの場所" },
  };
  const KORDER = Object.keys(KIND);
  const SOCIAL_TXT = ["", "交流はほぼない", "一人でも入れる", "隣と話すこともある", "隣や常連と話しやすい", "自然に会話が生まれる"];
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- state
  const store = {
    get(k, d) { try { const v = localStorage.getItem("nb:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("nb:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const saved = store.get("filters", {});
  const S = {
    kinds: new Set(saved.kinds && saved.kinds.length ? saved.kinds : KORDER),
    social: saved.social || 0,
    solo: !!saved.solo,
    hiru: !!saved.hiru,
    english: !!saved.english,
    favOnly: false,
    closed: !!saved.closed,
    area: "",
    q: "",
    sort: saved.sort || "social",
    scope: "view",
    selected: null,
  };
  const fav = new Set(store.get("fav", []));
  const persist = () => store.set("filters", { kinds: [...S.kinds], social: S.social, solo: S.solo, hiru: S.hiru, english: S.english, closed: S.closed, sort: S.sort });

  // ---------------------------------------------------------------- text search
  const norm = (s) => String(s || "").normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・･\-ー]/g, "");
  SPOTS.forEach((s) => {
    s._k = norm([s.name, s.kana, s.en, s.area, s.ward, s.station, KIND[s.kind]?.label, (s.tags || []).join(" "), s.desc, s.talk, s.address, s.price].join(" "));
    s._w = NBMap.project(s.lat, s.lng);
  });

  const matches = (s) => {
    if (!S.kinds.has(s.kind)) return false;
    if (s.status === "closed" && !S.closed) return false;
    if (S.social && (s.social || 0) < S.social) return false;
    if (S.solo && (s.solo || 0) < 4) return false;
    if (S.hiru && !s.hiru) return false;
    if (S.english && !s.english) return false;
    if (S.favOnly && !fav.has(s.id)) return false;
    if (S.area && s.area !== S.area) return false;
    if (S.q) {
      const terms = S.q.replace(/　/g, " ").trim().split(/\s+/).map(norm).filter(Boolean);
      if (!terms.every((t) => s._k.includes(t))) return false;
    }
    return true;
  };

  // ---------------------------------------------------------------- map
  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
  const map = L.map("map", {
    zoomControl: false,
    minZoom: 9,
    maxZoom: 19,
    maxBounds: [[35.3, 139.0], [36.0, 140.25]], // the context ring in base.json
    maxBoundsViscosity: 0.7,
    wheelPxPerZoomLevel: 100,
    attributionControl: true,
  });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('地図 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors');
  L.control.zoom({ position: "topright", zoomInTitle: "拡大", zoomOutTitle: "縮小" }).addTo(map);
  L.control.scale({ imperial: false, position: "bottomright", maxWidth: 120 }).addTo(map);
  map.createPane("yk").style.zIndex = 430;
  map.createPane("spots").style.zIndex = 620;
  map.createPane("areas").style.zIndex = 630;

  const panelPad = () => {
    const el = $("#panel");
    if (isPhone()) {
      const h = el.dataset.sheet === "peek" ? 210 : window.innerHeight * 0.56;
      return { paddingTopLeft: [24, 24], paddingBottomRight: [24, Math.round(h) + 16] };
    }
    return { paddingTopLeft: [Math.round(el.getBoundingClientRect().right) + 24, 24], paddingBottomRight: [56, 24] };
  };
  const allBounds = L.latLngBounds(SPOTS.filter((s) => s.status !== "closed").map((s) => [s.lat, s.lng]));

  // basemap ---------------------------------------------------------------
  let base = null, labels = null, raster = null;
  const matchedOsm = new Set(SPOTS.map((s) => s.osm).filter(Boolean));
  const loadBase = () => fetch((CFG.dataUrl || "data/") + "base.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((b) => {
      const st = new NBMap.Store(b, D.chunks, CFG.dataUrl || "data/");
      base = new NBMap.VectorLayer(st).addTo(map);
      labels = new NBMap.LabelLayer(st, {
        reserved: markerBoxes,
        skipPoi: (o) => !S.poi || matchedOsm.has(o.osm),
      }).addTo(map);
      base.onChunk = () => labels.redraw();
      document.body.classList.add("base-ready");
    })
    .catch(() => {
      $("#map-status").hidden = false;
      $("#map-status").textContent = "背景地図を読み込めませんでした。店の位置は表示しています。";
    });
  S.poi = store.get("poi", true);

  // optional aerial photo layer (only where the host allows remote tiles)
  if (CFG.raster) {
    raster = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", {
      maxNativeZoom: 18, maxZoom: 19, opacity: 1,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    });
  }

  // markers -----------------------------------------------------------------
  const spotLayer = L.layerGroup(); // syncZoom() puts it on the map from zoom 12
  const areaLayer = L.layerGroup();
  const ykLayer = L.layerGroup().addTo(map);
  const markers = new Map();
  const visible = new Set();

  const pinHtml = (s) => {
    const k = KIND[s.kind] || KIND.bar;
    return `<div class="pin-wrap k-${s.kind} s${s.social || 0}${s.status !== "open" ? " st-" + s.status : ""}${fav.has(s.id) ? " is-fav" : ""}">` +
      `<span class="pin"><span class="g">${k.g}</span></span><span class="pin-name">${esc(s.name)}</span></div>`;
  };
  SPOTS.forEach((s) => {
    const m = L.marker([s.lat, s.lng], {
      pane: "spots",
      icon: L.divIcon({ className: "spot-icon", html: pinHtml(s), iconSize: [24, 30], iconAnchor: [12, 15] }),
      title: s.name,
      keyboard: false, // the list is the keyboard path; 350 tab stops on the map would trap focus
      riseOnHover: true,
      zIndexOffset: (s.kind === "yokocho" ? 400 : 0) + (s.social || 0) * 40,
    });
    m.on("click", () => select(s.id, { fly: false }));
    markers.set(s.id, m);
    if (s.shape) {
      const parts = s.shape.p.map((enc) => {
        const a = NBMap.dec(enc), ll = [];
        for (let i = 0; i < a.length; i += 2) ll.push(NBMap.unproject(a[i], a[i + 1]));
        return ll;
      });
      const style = { pane: "yk", className: "yk-shape", weight: s.shape.t === "line" ? 7 : 2, interactive: true };
      const layer = s.shape.t === "line" ? L.polyline(parts, style) : L.polygon(parts, style);
      layer.on("click", () => select(s.id, { fly: false }));
      s._shape = layer;
    }
  });
  const refreshPin = (s) => {
    const m = markers.get(s.id);
    if (!m) return;
    m.setIcon(L.divIcon({ className: "spot-icon", html: pinHtml(s), iconSize: [24, 30], iconAnchor: [12, 15] }));
    s._tw = null;
    if (s.id === S.selected) m.getElement()?.classList.add("is-selected");
    declutter();
  };

  // screen boxes the label layer should keep clear
  function markerBoxes(tl, s) {
    const z = map.getZoom();
    if (z < 13) return [];
    const out = [];
    const r = z >= 15 ? 14 : 7;
    for (const id of visible) {
      const sp = BYID.get(id);
      const x = sp._w[0] * s - tl.x, y = sp._w[1] * s - tl.y;
      out.push([x - r, y - r - 2, x + r + (sp._nameW || 0), y + r + 2]);
    }
    return out;
  }

  // hide pin names that would overlap a more important pin or name
  const measure = document.createElement("canvas").getContext("2d");
  const nameWidth = (s) => {
    if (s._tw == null) {
      measure.font = `700 ${s.kind === "yokocho" ? 13 : 12}px ${getComputedStyle(document.body).fontFamily}`;
      s._tw = measure.measureText(s.name).width + (fav.has(s.id) ? 14 : 0);
    }
    return s._tw;
  };
  const declutter = () => {
    const z = map.getZoom();
    const showNames = z >= 16;
    const b = map.getBounds().pad(0.1);
    const items = [...visible].map((id) => BYID.get(id)).filter((s) => b.contains([s.lat, s.lng]));
    items.sort((a, c) => (c.id === S.selected) - (a.id === S.selected) || (c.kind === "yokocho") - (a.kind === "yokocho") || (c.social || 0) - (a.social || 0));
    const boxes = [];
    const hit = (q) => boxes.some((o) => q[0] < o[2] && q[2] > o[0] && q[1] < o[3] && q[3] > o[1]);
    for (const s of items) {
      const el = markers.get(s.id)?.getElement();
      const p = map.latLngToContainerPoint([s.lat, s.lng]);
      const pin = [p.x - 10, p.y - 13, p.x + 10, p.y + 13];
      let ok = false;
      if (showNames) {
        const w = nameWidth(s);
        const box = [p.x + 12, p.y - 9, p.x + 16 + w, p.y + 9];
        ok = s.id === S.selected || !hit(box);
        if (ok) boxes.push(box);
        s._nameW = ok ? w + 8 : 0;
      } else s._nameW = 0;
      boxes.push(pin);
      el?.classList.toggle("name-off", showNames && !ok);
    }
  };

  // bubbles for the city-wide view: regions up to z10, towns at z11, pins from z12
  const regionLayer = L.layerGroup();
  const REGION_SHORT = { "都心（新橋・銀座・神田）": "都心", "上野・浅草・日暮里": "上野・浅草", "新宿・中野・杉並": "新宿・中央線",
    "渋谷・目黒・世田谷": "渋谷・城南", "池袋・赤羽・城北": "池袋・赤羽", "墨田・江東・江戸川": "城東" };
  let bubbles = { area: [], region: [] };
  const bubble = (layer, name, spots, cls) => {
    const n = spots.length;
    const social = spots.filter((s) => (s.social || 0) >= 4).length;
    const lat = spots.reduce((a, s) => a + s.lat, 0) / n, lng = spots.reduce((a, s) => a + s.lng, 0) / n;
    const icon = L.divIcon({ className: "area-icon", html: `<button class="area-bubble ${cls}" type="button"><span>${esc(name)}</span><b>${n}</b></button>`, iconSize: null, iconAnchor: [0, 0] });
    const m = L.marker([lat, lng], { icon, pane: "areas", title: `${name}：${n}軒（交流しやすい店 ${social}軒）`, keyboard: false });
    m.on("click", () => map.flyToBounds(L.latLngBounds(spots.map((s) => [s.lat, s.lng])), { ...panelPad(), maxZoom: 16, duration: 0.8 }));
    layer.addLayer(m);
    return { m, n, w: name.length * (cls === "a-r" ? 15 : 13) + 44, h: cls === "a-r" ? 34 : 28, ll: L.latLng(lat, lng) };
  };
  const group = (list, key) => {
    const g = new Map();
    list.forEach((s) => { const k = s[key] || "その他"; (g.get(k) || g.set(k, []).get(k)).push(s); });
    return g;
  };
  const buildAreas = (list) => {
    areaLayer.clearLayers();
    regionLayer.clearLayers();
    bubbles = { area: [], region: [] };
    group(list, "area").forEach((spots, name) => {
      bubbles.area.push(bubble(areaLayer, name, spots, spots.length >= 15 ? "a-l" : spots.length >= 7 ? "a-m" : "a-s"));
    });
    group(list, "region").forEach((spots, name) => bubbles.region.push(bubble(regionLayer, REGION_SHORT[name] || name, spots, "a-r")));
  };
  // place bubbles biggest first; nudge a colliding one up, down or sideways, else hide it
  const declutterAreas = () => {
    const list = map.hasLayer(regionLayer) ? bubbles.region : map.hasLayer(areaLayer) ? bubbles.area : null;
    if (!list) return;
    const placed = [];
    const free = (q) => !placed.some((o) => q[0] < o[2] && q[2] > o[0] && q[1] < o[3] && q[3] > o[1]);
    [...list].sort((a, b) => b.n - a.n).forEach((b) => {
      const p = map.latLngToContainerPoint(b.ll);
      const tries = [[0, 0], [0, -b.h], [0, b.h], [b.w * 0.6, 0], [-b.w * 0.6, 0], [b.w * 0.5, -b.h], [-b.w * 0.5, b.h]];
      let at = null;
      for (const [dx, dy] of tries) {
        const q = [p.x + dx - b.w / 2, p.y + dy - b.h / 2, p.x + dx + b.w / 2, p.y + dy + b.h / 2];
        if (free(q)) { placed.push(q); at = [dx, dy]; break; }
      }
      const btn = b.m.getElement()?.firstElementChild;
      if (!btn) return;
      btn.style.visibility = at ? "" : "hidden";
      btn.style.transform = at ? `translate(calc(-50% + ${at[0]}px), calc(-50% + ${at[1]}px))` : "";
    });
  };

  const AREA_Z = 12, REGION_Z = 11;
  const syncZoom = () => {
    const z = map.getZoom();
    const el = map.getContainer();
    el.classList.toggle("z-mid", z >= AREA_Z && z < 15);
    el.classList.toggle("z-high", z >= 15);
    el.classList.toggle("z-name", z >= 16);
    const want = z < REGION_Z ? regionLayer : z < AREA_Z ? areaLayer : spotLayer;
    [regionLayer, areaLayer, spotLayer].forEach((l) => {
      if (l === want && !map.hasLayer(l)) map.addLayer(l);
      if (l !== want && map.hasLayer(l)) map.removeLayer(l);
    });
    declutterAreas();
    const showYk = z >= 14;
    SPOTS.forEach((s) => {
      if (!s._shape) return;
      const on = showYk && visible.has(s.id);
      if (on && !ykLayer.hasLayer(s._shape)) ykLayer.addLayer(s._shape);
      if (!on && ykLayer.hasLayer(s._shape)) ykLayer.removeLayer(s._shape);
    });
  };

  // ---------------------------------------------------------------- list
  const meter = (n, label) => `<span class="meter" role="img" aria-label="${label} ${n}/5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
  const yen = (s) => s.budget || (s.budget_min ? `¥${s.budget_min.toLocaleString()}〜` : "");

  const sorters = {
    social: (a, b) => (b.social || 0) - (a.social || 0) || (b.solo || 0) - (a.solo || 0) || (a.kind === "yokocho" ? -1 : 0) - (b.kind === "yokocho" ? -1 : 0) || a.name.localeCompare(b.name, "ja"),
    cheap: (a, b) => (a.budget_min ?? 1e9) - (b.budget_min ?? 1e9) || (b.social || 0) - (a.social || 0),
    near: (a, b) => a._d - b._d,
    name: (a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, "ja"),
  };

  let current = [];
  const PAGE = 150;
  let shown = PAGE;
  const render = () => {
    const filtered = SPOTS.filter(matches);
    visible.clear();
    filtered.forEach((s) => visible.add(s.id));
    markers.forEach((m, id) => {
      const on = visible.has(id);
      if (on && !spotLayer.hasLayer(m)) spotLayer.addLayer(m);
      if (!on && spotLayer.hasLayer(m)) spotLayer.removeLayer(m);
    });
    buildAreas(filtered);
    syncZoom();
    declutter();
    if (labels) labels.redraw();
    renderList(filtered);
    $("#total").textContent = filtered.length;
  };

  const renderList = (filtered = SPOTS.filter(matches), keepPage = false) => {
    if (!keepPage) shown = PAGE;
    const c = map.getCenter();
    const cw = NBMap.project(c.lat, c.lng);
    let list = filtered;
    const inView = S.scope === "view" && !S.q;
    if (inView) {
      const b = map.getBounds().pad(-0.02);
      list = list.filter((s) => b.contains([s.lat, s.lng]));
    }
    list.forEach((s) => { s._d = Math.hypot(s._w[0] - cw[0], s._w[1] - cw[1]); });
    list = [...list].sort(sorters[S.sort] || sorters.social);
    current = list;
    $("#count").textContent = inView ? `地図の範囲に ${list.length}軒` : `${list.length}軒`;
    $("#scope-hint").hidden = !(inView && list.length < filtered.length);
    const ol = $("#list");
    if (!list.length) {
      ol.innerHTML = `<li class="empty">${inView ? "この範囲に条件に合う店はありません。地図を動かすか、条件をゆるめてください。" : "条件に合う店はありません。"}</li>`;
      return;
    }
    const near = (s) => s.near && s.near[0] ? `${esc(s.near[0][0])}駅 ${walk(s.near[0][1])}` : esc(s.station || "");
    ol.innerHTML = list.slice(0, shown).map((s) => `
      <li class="card k-${s.kind}${s.id === S.selected ? " is-sel" : ""}" data-id="${s.id}">
        <button class="card-main" type="button" data-id="${s.id}">
          <span class="mini-pin" aria-hidden="true">${KIND[s.kind].g}</span>
          <span class="card-body">
            <span class="card-top"><span class="card-name">${esc(s.name)}</span>${s.status === "uncertain" ? '<span class="flag">要確認</span>' : ""}${s.status === "closed" ? '<span class="flag closed">閉店</span>' : ""}</span>
            <span class="card-meta">${esc(KIND[s.kind].label)} · ${esc(s.area_label || s.area)} · ${near(s)}</span>
            <span class="card-row">${meter(s.social || 0, "交流度")}<span class="card-yen">${esc(yen(s))}</span></span>
            ${s.talk ? `<span class="card-talk">${esc(s.talk)}</span>` : ""}
          </span>
        </button>
        <button class="fav${fav.has(s.id) ? " on" : ""}" type="button" data-fav="${s.id}" aria-pressed="${fav.has(s.id)}" title="行きたいリスト">${fav.has(s.id) ? "★" : "☆"}</button>
      </li>`).join("") + (list.length > shown ? `<li class="more"><button type="button" class="btn ghost" id="more">さらに表示（残り${list.length - shown}軒）</button></li>` : "");
  };
  const walk = (m) => (m < 1000 ? `${Math.max(1, Math.round(m / 80))}分` : `${(m / 1000).toFixed(1)}km`);

  // ---------------------------------------------------------------- detail
  const gmaps = (s) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.name} ${s.address || s.area}`)}`;
  const osmUrl = (s) => s.osm ? `https://www.openstreetmap.org/${{ n: "node", w: "way", r: "relation" }[s.osm[0]]}/${s.osm.slice(1)}` : `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=19/${s.lat}/${s.lng}`;
  const GEO_TXT = {
    osm: "OpenStreetMapの店舗データと一致",
    "osm-area": "OpenStreetMapの横丁・通りの形",
    gsi: "住所の建物位置（国土地理院の住所検索）",
    "gsi-block": "住所の街区の中心（国土地理院の住所検索）。数十m ずれることがあります",
    manual: "地図データから手作業で決めた位置",
    approx: "おおよその位置（要確認）",
  };

  const renderDetail = (s) => {
    const k = KIND[s.kind];
    const parent = s.yokocho && BYID.get(s.yokocho);
    const kids = s.kind === "yokocho" ? SPOTS.filter((x) => x.yokocho === s.id && x.status !== "closed") : [];
    const nearTxt = (s.near || []).map((n) => `${esc(n[0])}駅から約${Math.round(n[1] / 10) * 10}m（徒歩${walk(n[1])}）`).join("<br>");
    const facts = [
      ["住所", s.address ? `<span class="addr" id="addr-text">${esc(s.address)}${s.address_detail ? " " + esc(s.address_detail) : ""}</span> <button class="copy" type="button" data-copy="${esc(s.address + (s.address_detail ? " " + s.address_detail : ""))}">コピー</button>` : ""],
      ["アクセス", [esc(s.station), nearTxt].filter(Boolean).join("<br>")],
      ["営業時間", esc(s.hours)],
      ["定休日", esc(s.closed)],
      ["予算", esc(yen(s))],
      ["名物・価格", esc(s.price)],
      ["支払い", esc(s.payment)],
      ["喫煙", esc(s.smoking)],
      [s.kind === "yokocho" ? "店舗数" : "", s.shops ? `約${s.shops}軒` : ""],
      ["創業・成立", esc(s.since)],
    ].filter((f) => f[0] && f[1]);
    const el = $("#detail");
    el.innerHTML = `
      <div class="d-head k-${s.kind}">
        <button class="back" type="button" id="back">一覧にもどる</button>
        <button class="fav big${fav.has(s.id) ? " on" : ""}" type="button" data-fav="${s.id}" aria-pressed="${fav.has(s.id)}">${fav.has(s.id) ? "★ 行きたい" : "☆ 行きたい"}</button>
      </div>
      <div class="d-title k-${s.kind}">
        <span class="mini-pin big" aria-hidden="true">${k.g}</span>
        <div>
          <p class="d-kind">${esc(k.label)}${parent ? ` · <button class="link" type="button" data-go="${parent.id}">${esc(parent.name)}</button>の中` : ""}</p>
          <h2>${esc(s.name)}</h2>
          ${s.kana && s.kana !== s.name ? `<p class="d-kana">${esc(s.kana)}${s.en ? " · " + esc(s.en) : ""}</p>` : s.en ? `<p class="d-kana">${esc(s.en)}</p>` : ""}
        </div>
      </div>
      ${s.status !== "open" ? `<p class="d-warn">${s.status === "closed" ? "閉店・消滅の情報があります。" : "最近の営業情報が少ない店です。行く前に確認してください。"}${s.checked ? " " + esc(s.checked) : ""}</p>` : ""}
      <div class="d-scores">
        <div><span class="d-label">交流度</span>${meter(s.social || 0, "交流度")}<span class="d-score-txt">${SOCIAL_TXT[s.social || 0] || ""}</span></div>
        <div><span class="d-label">一人飲み</span>${meter(s.solo || 0, "一人飲みのしやすさ")}</div>
      </div>
      ${s.desc ? `<p class="d-desc">${esc(s.desc)}</p>` : ""}
      ${s.talk ? `<div class="d-talk"><h3>人と話すなら</h3><p>${esc(s.talk)}</p></div>` : ""}
      ${s.tips ? `<p class="d-tips"><b>行く前に</b>${esc(s.tips)}</p>` : ""}
      ${(s.tags || []).length ? `<ul class="tags">${s.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      <dl class="facts">${facts.map((f) => `<dt>${f[0]}</dt><dd>${f[1]}</dd>`).join("")}</dl>
      ${kids.length ? `<div class="d-kids"><h3>この横丁の店（${kids.length}）</h3><ul>${kids.map((x) => `<li><button class="link" type="button" data-go="${x.id}"><span class="mini-pin k-${x.kind}">${KIND[x.kind].g}</span>${esc(x.name)}</button></li>`).join("")}</ul></div>` : ""}
      <div class="d-links">
        <a class="btn" href="${gmaps(s)}" target="_blank" rel="noopener">Googleマップで開く</a>
        <a class="btn ghost" href="${osmUrl(s)}" target="_blank" rel="noopener">OpenStreetMap</a>
      </div>
      <div class="d-meta">
        <p><b>位置</b>${esc(GEO_TXT[s.geo] || "")}${s.gsi && /^gsi/.test(s.geo) ? `（${esc(s.gsi.replace(/^東京都/, ""))}）` : ""}　<span class="mono">${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}</span></p>
        ${s.checked ? `<p><b>営業確認</b>${esc(s.checked)}</p>` : ""}
        ${(s.sources || []).length ? `<p><b>出典</b>${s.sources.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(host(u))}</a>`).join("、")}</p>` : ""}
      </div>`;
    el.scrollTop = 0;
  };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

  let selMarker = null;
  const select = (id, { fly = true } = {}) => {
    const s = BYID.get(id);
    if (!s) return;
    S.selected = id;
    renderDetail(s);
    document.body.classList.add("show-detail");
    $("#detail").hidden = false;
    if (selMarker) selMarker.getElement()?.classList.remove("is-selected");
    const m = markers.get(id);
    if (m && !spotLayer.hasLayer(m)) spotLayer.addLayer(m);
    selMarker = m;
    if (isPhone()) setSheet("half");
    if (fly) {
      const z = Math.max(map.getZoom(), s.kind === "yokocho" ? 17 : 17.5);
      const target = s._shape && s.kind === "yokocho" ? s._shape.getBounds() : null;
      if (target && target.isValid()) map.flyToBounds(target, { ...panelPad(), maxZoom: 18, duration: 0.8 });
      else flyTo(s.lat, s.lng, Math.min(18, Math.round(z)));
    }
    setTimeout(() => m?.getElement()?.classList.add("is-selected"), fly ? 900 : 0);
    try { history.replaceState(null, "", "#" + id); } catch { /* sandboxed */ }
  };
  const flyTo = (lat, lng, z) => {
    // keep the point clear of the panel / sheet
    const p = panelPad();
    const target = map.project([lat, lng], z);
    const off = L.point((p.paddingTopLeft[0] - p.paddingBottomRight[0]) / 2, (p.paddingTopLeft[1] - p.paddingBottomRight[1]) / 2);
    map.flyTo(map.unproject(target.subtract(off), z), z, { duration: 0.8 });
  };
  const closeDetail = () => {
    S.selected = null;
    document.body.classList.remove("show-detail");
    $("#detail").hidden = true;
    selMarker?.getElement()?.classList.remove("is-selected");
    selMarker = null;
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* sandboxed */ }
    renderList();
  };

  // ---------------------------------------------------------------- controls
  const kindsEl = $("#kinds");
  kindsEl.innerHTML = KORDER.map((k) => `<button type="button" class="chip k-${k}" data-kind="${k}" aria-pressed="${S.kinds.has(k)}" title="${esc(KIND[k].note)}"><span class="mini-pin" aria-hidden="true">${KIND[k].g}</span>${KIND[k].label}<span class="n">${SPOTS.filter((s) => s.kind === k && s.status !== "closed").length}</span></button>`).join("");
  kindsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    const k = b.dataset.kind;
    if (e.altKey || e.metaKey) { S.kinds = new Set([k]); }
    else if (S.kinds.has(k)) { S.kinds.delete(k); if (!S.kinds.size) S.kinds = new Set(KORDER); }
    else S.kinds.add(k);
    kindsEl.querySelectorAll("[data-kind]").forEach((x) => x.setAttribute("aria-pressed", S.kinds.has(x.dataset.kind)));
    persist(); render();
  });

  const seg = (id, key, cast = (v) => v) => {
    const el = $(id);
    const sync = () => el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(cast(b.dataset.v) === S[key])));
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      S[key] = cast(b.dataset.v);
      sync(); persist(); key === "scope" || key === "sort" ? renderList() : render();
    });
    sync();
  };
  seg("#social", "social", Number);
  seg("#scope", "scope");

  const toggle = (id, key) => {
    const b = $(id);
    b.setAttribute("aria-pressed", S[key]);
    b.addEventListener("click", () => { S[key] = !S[key]; b.setAttribute("aria-pressed", S[key]); persist(); render(); });
  };
  toggle("#t-solo", "solo");
  toggle("#t-hiru", "hiru");
  toggle("#t-english", "english");
  toggle("#t-fav", "favOnly");
  toggle("#t-closed", "closed");
  const poiBtn = $("#t-poi");
  poiBtn.setAttribute("aria-pressed", S.poi);
  poiBtn.addEventListener("click", () => { S.poi = !S.poi; poiBtn.setAttribute("aria-pressed", S.poi); store.set("poi", S.poi); labels?.redraw(); });

  const areaSel = $("#area");
  const live = SPOTS.filter((s) => s.status !== "closed");
  const nArea = (a) => live.filter((s) => s.area === a).length;
  const regions = D.regions && D.regions.length ? D.regions : [{ name: "エリア", areas: [...new Set(live.map((s) => s.area))] }];
  areaSel.innerHTML = `<option value="">すべての街（${new Set(live.map((s) => s.area)).size}）</option>` +
    regions.map((r) => `<optgroup label="${esc(r.name)}">${r.areas.map((a) => `<option value="${esc(a)}">${esc(a)}（${nArea(a)}）</option>`).join("")}</optgroup>`).join("");
  areaSel.addEventListener("change", () => {
    S.area = areaSel.value;
    render();
    const list = SPOTS.filter((s) => (S.area ? s.area === S.area : true) && s.status !== "closed");
    if (list.length) map.flyToBounds(L.latLngBounds(list.map((s) => [s.lat, s.lng])), { ...panelPad(), maxZoom: 16, duration: 0.8 });
  });

  const sortSel = $("#sort");
  sortSel.value = S.sort;
  sortSel.addEventListener("change", () => { S.sort = sortSel.value; persist(); renderList(); });

  const q = $("#q");
  let qt = 0;
  q.addEventListener("input", () => {
    clearTimeout(qt);
    qt = setTimeout(() => { S.q = q.value.trim(); render(); }, 120);
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && current[0]) { select(current[0].id); q.blur(); }
  });

  $("#reset").addEventListener("click", () => {
    S.kinds = new Set(KORDER); S.social = 0; S.solo = S.hiru = S.english = S.favOnly = S.closed = false; S.area = ""; S.q = ""; q.value = ""; areaSel.value = "";
    kindsEl.querySelectorAll("[data-kind]").forEach((x) => x.setAttribute("aria-pressed", "true"));
    ["#t-solo", "#t-hiru", "#t-english", "#t-fav", "#t-closed"].forEach((id) => $(id).setAttribute("aria-pressed", "false"));
    $("#social").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === "0")));
    persist(); render();
  });

  // list & detail clicks
  document.addEventListener("click", (e) => {
    const f = e.target.closest("[data-fav]");
    if (f) {
      const id = f.dataset.fav;
      fav.has(id) ? fav.delete(id) : fav.add(id);
      store.set("fav", [...fav]);
      refreshPin(BYID.get(id));
      if (S.selected === id) renderDetail(BYID.get(id));
      renderList();
      return;
    }
    const go = e.target.closest("[data-go]");
    if (go) { select(go.dataset.go); return; }
    const card = e.target.closest(".card-main[data-id]");
    if (card) { select(card.dataset.id); return; }
    if (e.target.closest("#back")) { closeDetail(); return; }
    if (e.target.closest("#more")) { shown += PAGE; renderList(undefined, true); return; }
    const cp = e.target.closest("[data-copy]");
    if (cp) {
      const text = cp.dataset.copy;
      const done = () => { cp.textContent = "コピーしました"; setTimeout(() => (cp.textContent = "コピー"), 1600); };
      const fallback = () => { const r = document.createRange(); r.selectNodeContents($("#addr-text")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); cp.textContent = "選択しました"; };
      try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
    }
  });
  $("#list").addEventListener("mouseover", (e) => {
    const li = e.target.closest(".card");
    document.querySelectorAll(".pin-wrap.is-hover").forEach((x) => x.classList.remove("is-hover"));
    if (li) markers.get(li.dataset.id)?.getElement()?.querySelector(".pin-wrap")?.classList.add("is-hover");
  });

  // OSM points (unverified) popup
  map.on("click", (e) => {
    if (!labels || !S.poi) return;
    const o = labels.hit(e.containerPoint, 11);
    if (!o) return;
    const ll = NBMap.unproject(o.x, o.y);
    const type = { n: "node", w: "way", r: "relation" }[o.osm[0]];
    L.popup({ className: "poi-pop", maxWidth: 260, autoPanPaddingTopLeft: [isPhone() ? 10 : $("#panel").offsetWidth + 10, 10] })
      .setLatLng(ll)
      .setContent(`<p class="pp-kind">${esc(o.k)}<span>OSM登録・未検証</span></p><p class="pp-name">${esc(o.n)}</p>` +
        (o.lv ? `<p class="pp-row">${esc(o.lv)}階</p>` : "") +
        (o.h ? `<p class="pp-row">営業時間（OSM）: ${esc(o.h)}</p>` : "") +
        (o.ck ? `<p class="pp-row">OSMでの確認日: ${esc(o.ck)}</p>` : "") +
        `<p class="pp-links"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.n + " " + ll.lat.toFixed(5) + "," + ll.lng.toFixed(5))}" target="_blank" rel="noopener">Googleマップ</a><a href="https://www.openstreetmap.org/${type}/${o.osm.slice(1)}" target="_blank" rel="noopener">OSM</a></p>`)
      .openOn(map);
  });

  // ---------------------------------------------------------------- phone sheet
  const panel = $("#panel");
  const setSheet = (st) => {
    panel.dataset.sheet = st;
    $("#sheet-handle").setAttribute("aria-expanded", String(st !== "peek"));
  };
  $("#sheet-handle").addEventListener("click", () => setSheet(panel.dataset.sheet === "peek" ? "half" : panel.dataset.sheet === "half" ? "full" : "peek"));
  let dragY = null, dragH = 0;
  $("#sheet-handle").addEventListener("pointerdown", (e) => { if (!isPhone()) return; dragY = e.clientY; dragH = panel.getBoundingClientRect().height; panel.classList.add("dragging"); $("#sheet-handle").setPointerCapture(e.pointerId); });
  $("#sheet-handle").addEventListener("pointermove", (e) => { if (dragY == null) return; panel.style.height = Math.max(120, Math.min(window.innerHeight * 0.92, dragH + dragY - e.clientY)) + "px"; });
  $("#sheet-handle").addEventListener("pointerup", (e) => {
    if (dragY == null) return;
    const moved = Math.abs(e.clientY - dragY);
    const h = panel.getBoundingClientRect().height / window.innerHeight;
    panel.classList.remove("dragging"); panel.style.height = ""; dragY = null;
    if (moved > 8) { e.preventDefault(); setSheet(h < 0.3 ? "peek" : h < 0.7 ? "half" : "full"); }
  });
  q.addEventListener("focus", () => { if (isPhone() && panel.dataset.sheet === "peek") setSheet("half"); });

  // ---------------------------------------------------------------- about
  $("#about-open").addEventListener("click", () => { $("#about").hidden = false; $("#about-close").focus(); });
  $("#about-close").addEventListener("click", () => { $("#about").hidden = true; });
  $("#about").addEventListener("click", (e) => { if (e.target.id === "about") $("#about").hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#about").hidden) $("#about").hidden = true;
    else if (S.selected) closeDetail();
  });

  // locate (only where the host grants geolocation)
  if (CFG.geo && navigator.geolocation) {
    const b = $("#locate");
    b.hidden = false;
    let dot = null;
    b.addEventListener("click", () => {
      b.disabled = true;
      navigator.geolocation.getCurrentPosition((p) => {
        b.disabled = false;
        const ll = [p.coords.latitude, p.coords.longitude];
        if (!dot) dot = L.circleMarker(ll, { radius: 7, className: "me", pane: "areas" }).addTo(map);
        dot.setLatLng(ll);
        flyTo(ll[0], ll[1], 16);
        S.sort = "near"; sortSel.value = "near";
      }, () => { b.disabled = false; b.hidden = true; }, { enableHighAccuracy: true, timeout: 10000 });
    });
  }
  if (raster) {
    const b = $("#photo");
    b.hidden = false;
    b.addEventListener("click", () => {
      const on = !map.hasLayer(raster);
      on ? raster.addTo(map) : map.removeLayer(raster);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  // ---------------------------------------------------------------- theme
  const repaint = () => { base?.refreshPalette(); labels?.refreshPalette(); };
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", repaint);
  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

  // ---------------------------------------------------------------- go
  map.on("zoomend", syncZoom);
  map.on("moveend", () => { declutter(); declutterAreas(); if (S.scope === "view") renderList(); if (labels) labels.redraw(); });
  setSheet("peek");
  if (D.updated) $("#updated").textContent = D.updated;
  const hash = decodeURIComponent((location.hash || "").slice(1));
  map.fitBounds(allBounds, { ...panelPad(), maxZoom: 12 });
  render();
  loadBase();
  if (hash && BYID.has(hash)) select(hash);
  setTimeout(() => map.invalidateSize(), 50);
  window.__nb = { map, S, select };
  window.__ready = true;
})();
