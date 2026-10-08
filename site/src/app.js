/* 東京のんべえ地図 — the page around the map: search, filters, the list,
 * a page for every spot, what is open right now (Tokyo time, holidays
 * included), favourites and the phone's bottom sheet.
 */
(function () {
  "use strict";

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const KINDS = [
    ["yokocho", "飲み屋横丁", "横"], ["senbero", "せんべろ", "千"], ["tachinomi", "立ち飲み", "立"],
    ["kakuuchi", "角打ち", "角"], ["bar", "小さなバー", "酒"], ["social", "交流酒場", "交"],
  ];
  const KIND = Object.fromEntries(KINDS.map(([k, label, glyph]) => [k, { label, glyph }]));
  const SHORT = { yokocho: "横丁", senbero: "せんべろ", tachinomi: "立ち飲み", kakuuchi: "角打ち", bar: "バー", social: "交流酒場" };
  const TALK = ["", "会話より酒と肴", "一人でも入れる", "隣と話すこともある", "隣や常連と話しやすい", "自然に会話が生まれる"];
  const DAY_JP = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日", hol: "祝日", prehol: "祝前日", posthol: "祝後日" };
  const DK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const HOLIDAYS = new Set([
    "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06",
    "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
    "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05",
    "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
  ]);

  // ---------------------------------------------------------------- Tokyo time
  const JST = 9 * 3600e3, DAY = 864e5;
  const clockOverride = () => (window.NB_NOW ? new Date(window.NB_NOW).getTime() : Date.now());
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  function dayInfo(t) {   // t: ms shifted to JST
    const key = ymd(t);
    return { key, dow: new Date(t).getUTCDay(), hol: HOLIDAYS.has(key), prehol: HOLIDAYS.has(ymd(t + DAY)), posthol: HOLIDAYS.has(ymd(t - DAY)) };
  }
  function rangesFor(w, di) {
    if (di.hol && w.hol !== undefined) return w.hol;
    if (di.prehol && w.prehol !== undefined) return w.prehol;
    if (di.posthol && w.posthol !== undefined) return w.posthol;
    return w[DK[di.dow]];
  }
  const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  const hmNext = (m) => (m >= 1440 ? "翌" + hm(m - 1440) : hm(m));

  /** {open, until, lo} | {open:false, opensAt} | {open:false, closedToday, next} | null (unknown) */
  function openState(s, now) {
    const w = s.week;
    if (!w) return null;
    const t = (now || clockOverride()) + JST;
    const min = new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes();
    const today = dayInfo(t), yest = dayInfo(t - DAY);
    const ry = rangesFor(w, yest);
    if (ry) for (const [o, c, lo] of ry) if (c > 1440 && min + 1440 < c) return { open: true, until: c - 1440, lo: lo != null && lo >= 1440 ? lo - 1440 : null, left: c - 1440 - min };
    const rt = rangesFor(w, today);
    if (rt === undefined) return null;
    for (const [o, c, lo] of rt) if (min >= o && min < c) return { open: true, until: c, lo, left: c - min };
    const later = rt.filter((r) => r[0] > min).sort((a, b) => a[0] - b[0])[0];
    if (later) return { open: false, opensAt: later[0] };
    for (let k = 1; k <= 7; k++) {
      const di = dayInfo(t + k * DAY), r = rangesFor(w, di);
      if (r && r.length) return { open: false, closedToday: !rt.length, next: { k, di, o: r[0][0] } };
    }
    return { open: false, closedToday: true };
  }
  function stLabel(st, long) {
    if (!st) return null;
    if (st.open) {
      const soon = st.left <= 45;
      return { cls: soon ? "st-soon" : "st-open", text: soon ? `まもなく閉店 ${hmNext(st.until)}` : `営業中 〜${hmNext(st.until)}`, lamp: soon ? "soon" : "" };
    }
    if (st.opensAt != null) return { cls: "st-later", text: `${hm(st.opensAt)}から`, lamp: "off" };
    const nx = st.next ? `次は${st.next.k === 1 ? "明日" : st.next.di.hol ? "祝日" : DAY_JP[DK[st.next.di.dow]] + "曜"} ${hm(st.next.o)}から` : "";
    if (st.closedToday) return { cls: "st-off", text: long && nx ? `今日は休み・${nx}` : "今日は休み", lamp: "off" };
    return { cls: "st-off", text: long && nx ? `今日は終了・${nx}` : "今日は終了", lamp: "off" };
  }

  // ---------------------------------------------------------------- text helpers
  const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const norm = (s) => kata2hira(String(s || "").normalize("NFKC").toLowerCase()).replace(/[\s・･·,、。.]/g, "");
  const yen = (n) => n.toLocaleString("ja-JP");
  const dist = (a, b) => {
    const R = 6371e3, r = Math.PI / 180;
    const dl = (b.lat - a.lat) * r, dn = (b.lng - a.lng) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const walk = (m) => `${m < 1000 ? Math.round(m / 10) * 10 + "m" : (m / 1000).toFixed(1) + "km"}・徒歩${Math.max(1, Math.round(m / 80))}分`;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  const SRC_NAME = { "tabelog.com": "食べログ", "hotpepper.jp": "ホットペッパー", "retty.me": "Retty", "san-tatsu.jp": "さんたつ", "instagram.com": "Instagram", "x.com": "X", "twitter.com": "X" };
  const srcName = (u) => { const h = host(u); for (const k in SRC_NAME) if (h === k || h.endsWith("." + k)) return SRC_NAME[k]; return h; };
  const talkDots = (n, label) => `<span class="talk" aria-label="${label || "話しやすさ"}${n}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
  const seal = (k, on) => `<i class="seal${on ? " on" : ""}" style="--c:var(--k-${k})" aria-hidden="true">${KIND[k].glyph}</i>`;

  // ---------------------------------------------------------------- state
  const state = {
    q: "", area: "", sort: "social", scope: "view", sel: null,
    kinds: new Set(KINDS.map((k) => k[0])),
    f: { open: false, social: false, solo: false, hiru: false, cheap: false, card: false, english: false, fav: false },
    favs: new Set(store.get("nb-favs", [])),
    theme: store.get("nb-theme", "night"),
    three: store.get("nb-three2", false),
  };
  let D, spots, byId, atlas;
  const phone = () => matchMedia("(max-width: 820px)").matches;

  function searchText(s) {
    return norm([s.name, s.kana, s.en, s.area, s.ward, s.region, s.station, s.address, s.catch, (s.tags || []).join(" "),
      (s.menu || []).map((m) => m.n).join(" "), KIND[s.kind].label].join(" "));
  }
  function cheap(s) { return s.kind === "senbero" || (s.budget_max && s.budget_max <= 2500); }
  function pass(s, skip) {
    if (s.status === "closed") return false;
    if (skip !== "kind" && !state.kinds.has(s.kind)) return false;
    const f = state.f;
    if (f.open) { const st = openState(s); if (!st || !st.open) return false; }
    if (f.social && (s.social || 0) < 4) return false;
    if (f.solo && (s.solo || 0) < 4) return false;
    if (f.hiru && !s.hiru) return false;
    if (f.cheap && !cheap(s)) return false;
    if (f.card && s.cash_only !== false) return false;
    if (f.english && !s.english) return false;
    if (f.fav && !state.favs.has(s.id)) return false;
    if (state.area) {
      const [t, v] = [state.area.slice(0, 2), state.area.slice(2)];
      if (t === "r:" && s.region !== v) return false;
      if (t === "a:" && s.area !== v) return false;
    }
    if (state.q) {
      for (const tok of state.q.split(/\s+/).filter(Boolean)) if (!s._q.includes(norm(tok))) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    document.documentElement.dataset.theme = state.theme;
    syncThemeButton();
    try {
      D = await fetch((window.NB_CONFIG && NB_CONFIG.dataUrl || "data/") + "spots.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    } catch (e) {
      status("店のデータを読み込めませんでした。再読み込みしてください。");
      return;
    }
    spots = D.spots;
    spots.forEach((s) => { s._q = searchText(s); });
    byId = Object.fromEntries(spots.map((s) => [s.id, s]));
    buildFilters();
    bindUI();
    if (!window.maplibregl) { status("地図の部品を読み込めませんでした。通信状況を確かめて再読み込みしてください。"); renderList(); return; }
    const live = spots.filter((s) => s.status !== "closed");
    const cells = new Map();
    live.forEach((s) => { const k = Math.floor(s.lng / 0.0005) + ":" + Math.floor(s.lat / 0.0005); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(s); });
    atlas = new NBAtlas.Atlas($("#map"), {
      spots: live, chunks: D.chunks, theme: state.theme, three: state.three, capture: !!window.NB_CAPTURE, webSans: !!window.NB_CAPTURE,
      bounds: [[139.63, 35.625], [139.85, 35.755]],
      padding: () => (phone() ? { top: 80, bottom: 170, left: 20, right: 20 } : 50),
      showPoi: () => true,
      skipPoi: (o) => {
        // OSM shops that are one of ours are drawn as our lantern only
        if (o._skip === undefined) {
          const [lng, lat] = NBAtlas.toLngLat(o.x, o.y), cx = Math.floor(lng / 0.0005), cy = Math.floor(lat / 0.0005);
          o._skip = false;
          for (let i = -1; i <= 1 && !o._skip; i++) for (let j = -1; j <= 1; j++) {
            if ((cells.get((cx + i) + ":" + (cy + j)) || []).some((s) => Math.abs(s.lat - lat) < 0.00025 && Math.abs(s.lng - lng) < 0.0003)) { o._skip = true; break; }
          }
        }
        return o._skip;
      },
      onReady: () => { renderList(); fromHash(); },
      onError: () => status("地図のデータを読み込めませんでした。"),
      onDraw: () => syncNorth(),
    });
    window.nbAtlas = atlas;
    const m = atlas.map;
    m.on("click", (e) => {
      const h = atlas.hit(e.point);
      if (h && h.spot) { select(h.spot.id, { fly: false }); hidePoi(); }
      else if (h && h.poi) showPoi(h.poi);
      else hidePoi();
    });
    m.on("mousemove", (e) => {
      const h = atlas.hit(e.point);
      m.getCanvas().style.cursor = h ? "pointer" : "";
      atlas.setHover(h && h.spot ? h.spot.id : null);
      hlItem(h && h.spot ? h.spot.id : null);
    });
    m.on("moveend", () => { if (state.scope === "view" || state.sort === "near") renderListSoon(); });
    tick();
    setInterval(tick, 20e3);
    window.addEventListener("hashchange", fromHash);
  }

  // ---------------------------------------------------------------- filters
  function buildFilters() {
    const counts = {};
    spots.forEach((s) => { if (s.status !== "closed") counts[s.kind] = (counts[s.kind] || 0) + 1; });
    $("#kinds").innerHTML = KINDS.map(([k, label]) =>
      `<button type="button" class="seal-chip" data-k="${k}" aria-pressed="true" title="${label}" style="--c:var(--k-${k})">${seal(k)}<span>${SHORT[k]}</span><b>${counts[k] || 0}</b></button>`).join("");
    $("#legend-kinds").innerHTML = KINDS.map(([k, label]) => `<li>${seal(k, true)}${label}</li>`).join("");
    const opts = ['<option value="">東京全域</option>'];
    for (const r of D.regions) {
      const areas = r.areas.filter((a) => spots.some((s) => s.area === a && s.status !== "closed"));
      opts.push(`<optgroup label="${esc(r.name)}"><option value="r:${esc(r.name)}">${esc(r.name)} すべて</option>${areas.map((a) => `<option value="a:${esc(a)}">${esc(a)}</option>`).join("")}</optgroup>`);
    }
    $("#area").innerHTML = opts.join("");
    $("#about-count").textContent = `${spots.filter((s) => s.status !== "closed").length}軒`;
    if (D.updated) $("#updated").textContent = D.updated;
    if (D.accuracy) $("#accuracy").textContent = `食べログの店舗地図と比べられた${D.accuracy.n}軒では、ずれの中央値が${D.accuracy.median}m、9割が${D.accuracy.p90}m以内です。`;
    syncPressed();
  }
  function syncPressed() {
    $$("#kinds .seal-chip").forEach((b) => b.setAttribute("aria-pressed", String(state.kinds.has(b.dataset.k))));
    $$(".fuda").forEach((b) => b.setAttribute("aria-pressed", String(!!state.f[b.dataset.f])));
    $$("#scope button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === state.scope)));
    $("#nav-fav").setAttribute("aria-pressed", String(state.f.fav));
  }

  function bindUI() {
    $("#kinds").addEventListener("click", (e) => {
      const b = e.target.closest(".seal-chip");
      if (!b) return;
      const k = b.dataset.k;
      // first click on a full set picks just that kind; clicking the last one restores all
      if (state.kinds.size === KINDS.length) state.kinds = new Set([k]);
      else if (state.kinds.has(k)) { state.kinds.delete(k); if (!state.kinds.size) state.kinds = new Set(KINDS.map((x) => x[0])); }
      else state.kinds.add(k);
      changed();
    });
    $$(".fuda").forEach((b) => b.addEventListener("click", () => { state.f[b.dataset.f] = !state.f[b.dataset.f]; changed(); }));
    $("#nav-fav").addEventListener("click", () => { state.f.fav = !state.f.fav; changed(); if (phone()) sheet("half"); });
    $("#scope").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.scope = b.dataset.v; syncPressed(); renderList(); } });
    let qt;
    $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); if (state.q) state.scope = "all"; changed(); }, 120); });
    $("#q").addEventListener("focus", () => { if (phone()) sheet("full"); });
    $("#area").addEventListener("change", (e) => {
      state.area = e.target.value;
      state.scope = "all";
      changed();
      fitVisible();
    });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    $("#list").addEventListener("click", (e) => { const b = e.target.closest(".item"); if (b) select(b.dataset.id); });
    $("#list").addEventListener("mouseover", (e) => { const b = e.target.closest(".item"); if (atlas) atlas.setHover(b ? b.dataset.id : null); });
    $("#list").addEventListener("mouseleave", () => atlas && atlas.setHover(null));
    $("#nav-list").addEventListener("click", () => {
      const app = $("#app"), closed = app.classList.toggle("drawer-closed");
      $("#nav-list").setAttribute("aria-pressed", String(!closed));
      setTimeout(() => atlas && atlas.map.resize(), 340);
    });
    $("#nav-theme").addEventListener("click", () => setTheme(state.theme === "night" ? "day" : "night"));
    $("#nav-about").addEventListener("click", () => { $("#about").hidden = false; $("#about-close").focus(); });
    $("#about-close").addEventListener("click", () => { $("#about").hidden = true; });
    $("#about").addEventListener("click", (e) => { if (e.target.id === "about") $("#about").hidden = true; });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#about").hidden) $("#about").hidden = true;
      else if (!$("#poi-card").hidden) hidePoi();
      else if (state.sel) back();
    });
    $("#z-in").addEventListener("click", () => atlas && atlas.map.zoomIn());
    $("#z-out").addEventListener("click", () => atlas && atlas.map.zoomOut());
    $("#north").addEventListener("click", () => atlas && atlas.map.easeTo({ bearing: 0, duration: 500 }));
    $("#tilt").setAttribute("aria-pressed", String(state.three));
    $("#tilt").addEventListener("click", () => {
      state.three = !state.three; store.set("nb-three2", state.three);
      $("#tilt").setAttribute("aria-pressed", String(state.three));
      if (atlas) atlas.setThree(state.three);
    });
    if (!("geolocation" in navigator)) $("#locate").hidden = true;
    $("#locate").addEventListener("click", locate);
    bindSheet();
  }

  function changed() {
    syncPressed();
    renderList();
    if (atlas) atlas.setVisible(spots.filter((s) => pass(s)).map((s) => s.id));
  }
  function fitVisible() {
    if (!atlas) return;
    const vis = spots.filter((s) => pass(s));
    if (!vis.length) return;
    let w = 180, e = -180, so = 90, n = -90;
    vis.forEach((s) => { w = Math.min(w, s.lng); e = Math.max(e, s.lng); so = Math.min(so, s.lat); n = Math.max(n, s.lat); });
    const pad = phone() ? { top: 90, bottom: 200, left: 30, right: 30 } : 70;
    atlas.map.fitBounds([[w - 0.004, so - 0.003], [e + 0.004, n + 0.003]], { padding: pad, maxZoom: 16, duration: 900, pitch: state.three ? 40 : 0 });
  }

  // ---------------------------------------------------------------- list
  let listT;
  function renderListSoon() { clearTimeout(listT); listT = setTimeout(renderList, 160); }
  function inView(s) {
    if (!atlas) return true;
    const b = atlas.map.getBounds();
    return s.lng >= b.getWest() && s.lng <= b.getEast() && s.lat >= b.getSouth() && s.lat <= b.getNorth();
  }
  function renderList() {
    if (!spots) return;
    const all = spots.filter((s) => pass(s));
    let rows = state.scope === "view" ? all.filter(inView) : all;
    const c = atlas ? atlas.map.getCenter() : { lat: 35.68, lng: 139.76 };
    const sts = new Map(rows.map((s) => [s.id, openState(s)]));
    const key = {
      social: (a, b) => (b.social || 0) - (a.social || 0) || (b.solo || 0) - (a.solo || 0) || openRank(sts.get(b.id)) - openRank(sts.get(a.id)),
      near: (a, b) => dist(c, a) - dist(c, b),
      open: (a, b) => closeAt(sts.get(b.id)) - closeAt(sts.get(a.id)) || (b.social || 0) - (a.social || 0),
      cheap: (a, b) => (a.budget_min || 9e3) - (b.budget_min || 9e3) || (a.budget_max || 9e3) - (b.budget_max || 9e3),
      name: (a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, "ja"),
    }[state.sort];
    rows = rows.slice().sort(key);
    $("#count").textContent = rows.length;
    $("#count-sub").textContent = state.scope === "view" ? `軒（全域 ${all.length}軒）` : "軒";
    if (!rows.length) {
      $("#list").innerHTML = `<li class="empty">${state.scope === "view" && all.length ? `地図の範囲に当てはまる店がありません。<br><button type="button" data-act="all">全域の${all.length}軒を見る</button>` : "当てはまる店がありません。条件を減らしてみてください。"}</li>`;
      const b = $("#list [data-act=all]");
      if (b) b.addEventListener("click", () => { state.scope = "all"; syncPressed(); renderList(); });
      return;
    }
    const showDist = state.sort === "near";
    $("#list").innerHTML = rows.map((s) => {
      const st = stLabel(sts.get(s.id));
      const meta = [
        st ? `<span class="st ${st.cls}">${st.text}</span>` : "",
        `<span>${esc(s.area)}</span>`,
        s.budget ? `<span>${esc(shortBudget(s.budget))}</span>` : "",
        s.kind !== "yokocho" ? talkDots(s.social || 0) : "",
      ].filter(Boolean).join("");
      return `<li><button type="button" class="item${s.id === state.sel ? " hl" : ""}" data-id="${s.id}">
        ${seal(s.kind, true)}
        <span><span class="item-kana">${esc(s.kana || "")}</span><span class="item-name">${esc(s.name)}</span>
        <span class="item-catch">${esc(s.catch || firstSentence(s.desc))}</span>
        <span class="item-meta">${meta}</span></span>
        <span class="item-side">${state.favs.has(s.id) ? '<svg class="fav-mark" aria-label="行きたい"><use href="#i-star-f"/></svg>' : ""}${showDist ? `<br>${Math.round(dist(c, s) / 10) * 10}m` : ""}</span>
      </button></li>`;
    }).join("");
  }
  const openRank = (st) => (st && st.open ? 2 : st && st.opensAt != null ? 1 : 0);
  const closeAt = (st) => (st && st.open ? 2000 + st.until : st && st.opensAt != null ? 1000 + st.opensAt : 0);
  const firstSentence = (t) => (t || "").split("。")[0] + ((t || "").includes("。") ? "。" : "");
  const shortBudget = (b) => b.replace(/（.*?）/g, "").replace(/円$/, "円").slice(0, 16);
  function hlItem(id) {
    $$("#list .item.hl").forEach((el) => { if (el.dataset.id !== state.sel) el.classList.remove("hl"); });
    if (id) { const el = $(`#list .item[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add("hl"); }
  }

  // ---------------------------------------------------------------- one spot
  function select(id, opts) {
    const s = byId[id];
    if (!s) return;
    opts = opts || {};
    state.sel = id;
    if (atlas) atlas.select(id);
    $("#detail").innerHTML = detailHTML(s);
    $("#detail").hidden = false;
    $("#detail").scrollTop = 0;
    bindDetail(s);
    if (phone()) sheet(opts.sheet || "half");
    else if ($("#app").classList.contains("drawer-closed")) $("#nav-list").click();
    if (atlas && opts.fly !== false) atlas.flyToSpot(s, phone() ? [0, -Math.round(innerHeight * 0.2)] : [0, 0]);
    if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
    document.title = `${s.name} — 東京のんべえ地図`;
  }
  function back() {
    state.sel = null;
    if (atlas) atlas.select(null);
    $("#detail").hidden = true;
    history.replaceState(null, "", location.pathname + location.search);
    document.title = "東京のんべえ地図 — 立ち飲み・角打ち・せんべろ・横丁";
    renderList();
    if (phone()) sheet("half");
  }
  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && byId && byId[id] && id !== state.sel) select(id, { sheet: "half" });
  }

  // furigana over the shop name only, not over a trailing note such as （角打ち明治屋）
  function nameRuby(s) {
    if (!s.kana) return esc(s.name);
    const m = s.name.match(/^(.*?)([（(].*)$/);
    return m ? `<ruby>${esc(m[1])}<rt>${esc(s.kana)}</rt></ruby><span class="d-name-note">${esc(m[2])}</span>` : `<ruby>${esc(s.name)}<rt>${esc(s.kana)}</rt></ruby>`;
  }
  function fact(label, value, src, sub) {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "";
    return `<dt>${label}</dt><dd>${value}${src ? `<span class="src-tag">${esc(src)}</span>` : ""}${sub ? `<small>${sub}</small>` : ""}</dd>`;
  }
  function weekTable(s) {
    const w = s.week, t = clockOverride() + JST, today = dayInfo(t);
    const todayKey = today.hol && w.hol !== undefined ? "hol" : today.prehol && w.prehol !== undefined ? "prehol" : DK[today.dow];
    const rows = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "hol", "prehol"].filter((d) => w[d] !== undefined);
    return `<table class="hours"><tbody>${rows.map((d) => {
      const r = w[d];
      const cell = !r.length ? '<td class="off">休み</td>' : `<td>${r.map(([o, c, lo]) => `${hm(o)}〜${hmNext(c)}${lo != null ? `<span class="lo">L.O.${hmNext(lo)}</span>` : ""}`).join("<br>")}</td>`;
      return `<tr class="${d === todayKey ? "today" : ""}"><th>${DAY_JP[d]}</th>${cell}</tr>`;
    }).join("")}</tbody></table>`;
  }
  function nearby(s) {
    return spots.filter((o) => o.id !== s.id && o.status !== "closed")
      .map((o) => ({ o, d: dist(s, o) })).filter((x) => x.d < 1500).sort((a, b) => a.d - b.d).slice(0, 4);
  }
  function detailHTML(s) {
    const st = openState(s), sl = stLabel(st, true), src = s.src || {}, fav = state.favs.has(s.id);
    const yk = s.kind === "yokocho";
    const h = [];
    h.push(`<div class="d-bar">
      <button type="button" class="t-btn" data-act="back"><svg><use href="#i-back"/></svg>一覧</button><span class="sp"></span>
      <button type="button" class="t-btn" data-act="fav" aria-pressed="${fav}"><svg><use href="#${fav ? "i-star-f" : "i-star"}"/></svg>行きたい</button>
      <button type="button" class="t-btn" data-act="share"><svg><use href="#i-share"/></svg>共有</button></div>`);
    h.push(`<header class="d-head">
      <p class="d-kind">${seal(s.kind, true)}${KIND[s.kind].label}・${esc(s.area)}${s.ward && !s.area.includes(s.ward) ? `（${esc(s.ward)}）` : ""}</p>
      <h2 class="d-name">${nameRuby(s)}</h2>
      ${s.en ? `<p class="d-en">${esc(s.en)}</p>` : ""}
      ${s.catch ? `<p class="d-catch">${esc(s.catch)}</p>` : ""}
      <p class="d-desc">${esc(s.desc)}</p></header>`);
    if (s.status === "uncertain" || s.status_note) {
      h.push(`<p class="d-alert">${s.status_note === "closed" ? "最近の口コミや記事に閉店・休業の情報があります。" : "営業しているか確かめきれていません。"}出かける前に店の最新情報を確認してください。</p>`);
    }
    if (sl) h.push(`<div class="d-now"><i class="lamp ${sl.lamp}"></i><b class="${sl.cls}">${sl.text}</b><span>${st && st.open && st.lo != null ? `ラストオーダー ${hmNext(st.lo)}・` : ""}東京の現在時刻で判定${s.week_from_text ? "（調査メモの営業時間から）" : ""}</span></div>`);
    else if (!yk) h.push(`<div class="d-now"><i class="lamp off"></i><b class="st-off">営業時間は下を確認</b><span>曜日ごとの時間が分からないため、今の営業は判定していません</span></div>`);

    // 話しやすさ
    if (!yk || s.talk) {
      h.push(`<section class="d-sec"><h3>話しやすさ</h3>
        ${!yk ? `<div class="talk-big">${talkDots(s.social || 0)}<b>${TALK[s.social || 0] || ""}</b></div>` : ""}
        ${!yk && s.solo ? `<div class="talk-big solo">${talkDots(s.solo, "一人で入りやすさ")}<span>一人で入りやすさ ${["", "グループ向け", "グループ客が多い", "一人でも入れる", "一人客が多い", "一人客が大半"][s.solo] || ""}</span></div>` : ""}
        ${s.talk ? `<p>${esc(s.talk)}</p>` : ""}${s.talk2 ? `<p>${esc(s.talk2)}</p>` : ""}
        ${s.tags && s.tags.length ? `<ul class="tags">${s.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</section>`);
    }
    // facts
    const budgetSub = [s.budget_dinner ? `食べログ・夜 ${s.budget_dinner}` : "", s.budget_lunch ? `昼 ${s.budget_lunch}` : ""].filter(Boolean).join("／");
    const seats = s.seats ? `${s.seats}席${s.seats_note ? `（${esc(s.seats_note)}）` : ""}` : "";
    const facts = [
      fact("予算", s.budget ? esc(s.budget) : s.budget_dinner ? esc(s.budget_dinner) : "", s.budget ? "調査" : "食べログ", s.budget ? esc(budgetSub) : ""),
      fact("チャージ", s.charge ? esc(s.charge) : "", src.charge),
      fact("支払い", s.pay ? esc(s.pay) : "", src.pay),
      fact("席", seats, src.seats),
      fact("店内", s.seating ? esc(s.seating.join("・")) : ""),
      fact("喫煙", s.smoking ? esc(s.smoking) : "", src.smoking),
      fact("予約", s.reserve ? esc(s.reserve) : ""),
      fact("酒", s.drinks ? esc(s.drinks.join("・")) : ""),
      fact("電話", s.phone ? `<a href="tel:${esc(s.phone.replace(/[^\d+]/g, ""))}">${esc(s.phone)}</a>` : ""),
      fact("創業", s.since ? esc(s.since) : s.opened ? esc(String(s.opened).replace(/^(\d{4})\.(\d{1,2}).*$/, "$1年$2月開店")) : ""),
      fact("昼飲み", s.hiru ? "15時より前から飲める" : ""),
      fact("英語", s.english ? "英語メニューや英語での対応あり" : ""),
    ].join("");
    if (facts) h.push(`<section class="d-sec"><h3>基本の情報</h3><dl class="facts">${facts}</dl></section>`);

    if (s.vibe || s.crowd || s.busy) {
      h.push(`<section class="d-sec"><h3>${yk ? "横丁の様子" : "店の様子"}<small>口コミ・記事から</small></h3>
        ${s.vibe ? `<p>${esc(s.vibe)}</p>` : ""}
        ${s.crowd ? `<p class="d-sub"><em>客層</em>${esc(s.crowd)}</p>` : ""}
        ${s.busy ? `<p class="d-sub"><em>混む時間</em>${esc(s.busy)}</p>` : ""}</section>`);
    }
    if ((s.menu && s.menu.length) || s.price) {
      h.push(`<section class="d-sec"><h3>品書き<small>${s.menu && s.menu.length ? "口コミ・記事に出てくる値段" : ""}</small></h3>
        ${s.menu && s.menu.length ? `<ul class="menu">${s.menu.map((m) => `<li><span class="n">${esc(m.n)}</span><i class="leader"></i><span class="p">${m.p ? esc(m.p) : "—"}</span></li>`).join("")}</ul>` : ""}
        ${s.price ? `<p class="menu-note">${esc(s.price)}</p>` : ""}</section>`);
    }
    if (s.rules && s.rules.length) h.push(`<section class="d-sec"><h3>店の決まり</h3><ul class="rules">${s.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>`);
    if (s.first || s.tips) h.push(`<section class="d-sec"><h3>はじめて行くなら</h3>${s.first ? `<p>${esc(s.first)}</p>` : ""}${s.tips ? `<p>${esc(s.tips)}</p>` : ""}</section>`);
    if (s.week || s.hours || s.closed) {
      h.push(`<section class="d-sec"><h3>営業時間${src.hours ? `<small>${esc(src.hours)}</small>` : ""}</h3>
        ${s.week ? weekTable(s) : `<p>${esc(s.hours || "")}</p>`}
        ${s.closed ? `<p class="hours-note">定休日：${esc(s.closed)}</p>` : ""}
        ${s.hours_research && s.hours_research !== s.hours ? `<p class="hours-note">調査メモ：${esc(s.hours_research)}</p>` : ""}</section>`);
    }
    // access
    const gq = encodeURIComponent(`${s.name} ${s.address || ""}`.trim());
    const nearSt = (s.near || []).slice(0, 2).map(([n, m]) => `${esc(n)}駅から${walk(m)}`).join("、");
    h.push(`<section class="d-sec"><h3>行き方</h3>
      ${s.station ? `<p>${esc(s.station)}</p>` : ""}${nearSt ? `<p class="hours-note">${nearSt}（直線距離）</p>` : ""}
      ${s.address ? `<p class="addr"><span>${esc(s.address)}</span><button type="button" data-act="copy" title="住所をコピー" aria-label="住所をコピー"><svg><use href="#i-copy"/></svg></button></p>` : ""}
      <div class="btns">
        <a class="btn primary" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=walking" target="_blank" rel="noopener"><svg><use href="#i-route"/></svg>経路を調べる</a>
        <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${gq}" target="_blank" rel="noopener"><svg><use href="#i-ext"/></svg>Googleマップ</a>
        ${linkBtns(s)}
      </div></section>`);
    const nb = nearby(s);
    if (nb.length) {
      h.push(`<section class="d-sec"><h3>はしごするなら<small>近い順</small></h3><ul class="near-list">${nb.map(({ o, d }) => {
        const ol = stLabel(openState(o));
        return `<li><button type="button" class="near-item" data-id="${o.id}">${seal(o.kind, true)}<span><b>${esc(o.name)}</b><span>${esc(o.catch || KIND[o.kind].label)}${ol ? `・<span class="${ol.cls}">${ol.text}</span>` : ""}</span></span><em>${walk(d)}</em></button></li>`;
      }).join("")}</ul></section>`);
    }
    // sources
    const srcs = (s.sources || []).filter((u, i, a) => a.indexOf(u) === i);
    h.push(`<section class="d-sec"><h3>出典と確認</h3>
      ${s.checked ? `<p class="src-meta">紹介文：${esc(s.checked)}</p>` : ""}
      ${s.checked_reviews ? `<p class="src-meta">店の様子・品書き：${esc(s.checked_reviews)}</p>` : ""}
      ${srcs.length ? `<ul class="src-list">${srcs.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(srcName(u))}</a></li>`).join("")}</ul>` : ""}</section>`);
    h.push(`<p class="d-foot">情報は変わります。営業時間・値段・決まりは出かける前に店の最新情報で確かめてください。位置は${s.geo === "osm" ? "OpenStreetMap の店舗" : "住所"}から求めています。</p>`);
    return h.join("");
  }
  function linkBtns(s) {
    const l = s.links || {}, out = [];
    if (l.tabelog) out.push(`<a class="btn" href="${esc(l.tabelog)}" target="_blank" rel="noopener">食べログ</a>`);
    if (l.hotpepper) out.push(`<a class="btn" href="${esc(l.hotpepper)}" target="_blank" rel="noopener">ホットペッパー</a>`);
    if (l.web) out.push(`<a class="btn" href="${esc(l.web)}" target="_blank" rel="noopener"><svg><use href="#i-globe"/></svg>公式</a>`);
    if (l.insta) out.push(`<a class="btn" href="${esc(l.insta)}" target="_blank" rel="noopener"><svg><use href="#i-insta"/></svg>Instagram</a>`);
    if (l.x) out.push(`<a class="btn" href="${esc(l.x)}" target="_blank" rel="noopener">X</a>`);
    return out.join("");
  }
  function bindDetail(s) {
    const el = $("#detail");
    el.querySelector("[data-act=back]").addEventListener("click", back);
    el.querySelector("[data-act=fav]").addEventListener("click", (e) => {
      const b = e.currentTarget;
      if (state.favs.has(s.id)) state.favs.delete(s.id); else state.favs.add(s.id);
      store.set("nb-favs", [...state.favs]);
      const on = state.favs.has(s.id);
      b.setAttribute("aria-pressed", String(on));
      b.querySelector("use").setAttribute("href", on ? "#i-star-f" : "#i-star");
      toast(on ? "行きたい店に入れました" : "行きたい店から外しました");
    });
    el.querySelector("[data-act=share]").addEventListener("click", async () => {
      const url = location.origin + location.pathname + "#" + s.id;
      const text = `${s.name}（${KIND[s.kind].label}・${s.area}）${s.catch ? " " + s.catch : ""}`;
      if (navigator.share) { try { await navigator.share({ title: s.name, text, url }); return; } catch (e) { if (e.name === "AbortError") return; } }
      copy(url, "リンクをコピーしました");
    });
    const c = el.querySelector("[data-act=copy]");
    if (c) c.addEventListener("click", () => copy(s.address, "住所をコピーしました"));
    el.querySelectorAll(".near-item").forEach((b) => b.addEventListener("click", () => select(b.dataset.id)));
  }

  // ---------------------------------------------------------------- OSM spots
  function showPoi(o) {
    const card = $("#poi-card");
    const [type, id] = [{ n: "node", w: "way", r: "relation" }[o.osm[0]], o.osm.slice(1)];
    card.innerHTML = `<button type="button" class="m-btn" aria-label="閉じる"><svg><use href="#i-x"/></svg></button>
      <span class="tag">OpenStreetMap に登録された店・この地図では未確認</span><b>${esc(o.n)}</b>
      <p>${esc(o.k)}${o.lv ? `・${esc(o.lv)}階` : ""}</p>${o.h ? `<p>営業時間（OSM）：${esc(o.h)}</p>` : ""}
      <p><a href="https://www.openstreetmap.org/${type}/${id}" target="_blank" rel="noopener">OpenStreetMap で見る</a></p>`;
    card.hidden = false;
    card.querySelector("button").addEventListener("click", hidePoi);
  }
  function hidePoi() { $("#poi-card").hidden = true; }

  // ---------------------------------------------------------------- clock
  let lastMin = -1;
  function tick() {
    const t = new Date(clockOverride() + JST);
    const min = t.getUTCHours() * 60 + t.getUTCMinutes();
    if (min === lastMin) return;
    lastMin = min;
    const di = dayInfo(t.getTime());
    $("#clock").textContent = `${t.getUTCMonth() + 1}月${t.getUTCDate()}日（${di.hol ? "祝" : DAY_JP[DK[di.dow]]}）${hm(min)}`;
    const open = spots.filter((s) => s.status !== "closed" && (openState(s) || {}).open).length;
    $("#open-count").innerHTML = `いま <b>${open}</b>軒が営業中`;
    const list = $("#list"), top = list.scrollTop;
    renderList();
    list.scrollTop = top;
    if (state.sel && !$("#detail").hidden) {
      const now = $("#detail .d-now");
      const s = byId[state.sel], sl = stLabel(openState(s), true);
      if (now && sl) { now.querySelector("b").className = sl.cls; now.querySelector("b").textContent = sl.text; now.querySelector(".lamp").className = "lamp " + sl.lamp; }
    }
  }

  // ---------------------------------------------------------------- theme, misc
  function setTheme(t) {
    state.theme = t;
    store.set("nb-theme", t);
    document.documentElement.dataset.theme = t;
    $('meta[name="theme-color"]').setAttribute("content", t === "night" ? "#0b0f19" : "#f4f4f1");
    syncThemeButton();
    if (atlas) atlas.setTheme(t);
  }
  function syncThemeButton() {
    const night = state.theme === "night";
    $("#nav-theme use").setAttribute("href", night ? "#i-sun" : "#i-moon");
    $("#nav-theme span").textContent = night ? "昼" : "夜";
    $("#nav-theme").title = night ? "昼の地図にする" : "夜の地図にする";
  }
  function syncNorth() {
    if (!atlas) return;
    $("#north-icon").style.transform = `rotate(${-atlas.map.getBearing()}deg)`;
  }
  let me;
  function locate() {
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = [p.coords.longitude, p.coords.latitude];
      if (!me) { const el = document.createElement("div"); el.className = "me-dot"; me = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(atlas.map); }
      else me.setLngLat(ll);
      atlas.map.flyTo({ center: ll, zoom: Math.max(atlas.map.getZoom(), 15.5), duration: 1200 });
      state.sort = "near"; $("#sort").value = "near"; state.scope = "view"; syncPressed();
    }, () => toast("現在地を取得できませんでした"), { enableHighAccuracy: true, timeout: 10e3 });
  }
  function copy(text, msg) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(msg), () => toast(text));
  }
  let toastT;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2200);
  }
  function status(msg) { const el = $("#map-status"); el.textContent = msg; el.hidden = !msg; }

  // ---------------------------------------------------------------- phone sheet
  function sheet(v) { if (phone()) $("#drawer").dataset.sheet = v; }
  function bindSheet() {
    const dr = $("#drawer");
    let y0 = null, t0 = 0, base = 0, moved = false;
    const H = () => dr.getBoundingClientRect().height;
    const visOf = (v) => (v === "full" ? H() : v === "half" ? H() * 0.54 : 148);
    const down = (e) => {
      if (!phone()) return;
      y0 = e.clientY; t0 = performance.now(); base = visOf(dr.dataset.sheet); moved = false;
      dr.classList.add("dragging");
      e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > 4) moved = true;
      const vis = Math.max(110, Math.min(H(), base - dy));
      dr.style.transform = `translateY(${H() - vis}px)`;
    };
    const up = (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0, v = dy / Math.max(1, performance.now() - t0);
      dr.classList.remove("dragging");
      dr.style.transform = "";
      y0 = null;
      if (!moved) { dr.dataset.sheet = dr.dataset.sheet === "peek" ? "half" : dr.dataset.sheet === "half" ? "full" : "half"; return; }
      const vis = base - dy, h = H();
      const order = ["peek", "half", "full"];
      let pick = order.reduce((a, b) => (Math.abs(visOf(b) - vis) < Math.abs(visOf(a) - vis) ? b : a));
      if (Math.abs(v) > 0.6) pick = order[Math.max(0, Math.min(2, order.indexOf(dr.dataset.sheet) + (v < 0 ? 1 : -1)))];
      if (h && pick) dr.dataset.sheet = pick;
    };
    for (const el of [$("#sheet-handle"), $(".tonight")]) {
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    }
  }

  window.NB = { select, back, state, openState, setTheme, renderList, changed, spots: () => spots, byId: () => byId };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
