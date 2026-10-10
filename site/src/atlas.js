/* 東京のんべえ地図 — the map.
 *
 * MapLibre GL draws the city from OpenStreetMap data that ships with the page
 * (data/base.json, base_hi.json, c/ street chunks, b/ building chunks; see
 * scripts/build_*.py). A canvas laid over the WebGL canvas draws what needs
 * Japanese typography: station names with their readings, place names, the
 * OSM drinking spots and the lantern markers of the curated spots.
 * Geometry arrives as polyline-encoded Web Mercator units at zoom 18.
 */
(function () {
  "use strict";

  const Z0 = 18;
  const WU = 256 * 2 ** Z0;
  const CHUNK = 256 * 2 ** (Z0 - 12);
  const SIZE = { c: CHUNK, b: CHUNK / 2 };
  // small map labels use the device's own gothic; names of the spots, the
  // yokocho signs and ward names are set in Shippori Mincho (loaded on demand)
  let SANS = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",Meiryo,"Noto Sans CJK JP","Noto Sans JP",sans-serif';
  const SERIF = '"Shippori Mincho B1","Hiragino Mincho ProN","Yu Mincho","Noto Serif CJK JP","Noto Serif JP",serif';
  const VROT = new Set([..."ー－―〜～…‥（）()「」『』-=＝"]);

  // ------------------------------------------------------------------ geometry
  const toLngLat = (x, y) => [x / WU * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / WU))) * 180 / Math.PI];
  const fromLngLat = (lng, lat) => {
    const s = Math.sin(lat * Math.PI / 180);
    return [(lng + 180) / 360 * WU, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WU];
  };

  function dec(s, x, y) {
    const out = [];
    let i = 0, r, sh, b;
    x = x || 0; y = y || 0;
    while (i < s.length) {
      r = 0; sh = 0;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      x += (r & 1) ? ~(r >> 1) : (r >> 1);
      r = 0; sh = 0;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      y += (r & 1) ? ~(r >> 1) : (r >> 1);
      out.push(x, y);
    }
    return out;
  }

  const POLY = new Set([1, 2, 3, 4, 5, 6]);

  // [class, minzoom, attr, part...] → GeoJSON features
  function toGeo(raw, origin, colours, out) {
    const cls = raw[0], z = raw[1], attr = raw[2];
    let cx = origin ? origin[0] : 0, cy = origin ? origin[1] : 0;
    const rings = [];
    for (let k = 3; k < raw.length; k++) {
      const p = dec(raw[k], cx, cy);
      if (p.length) { cx = p[p.length - 2]; cy = p[p.length - 1]; }
      rings.push(p);
    }
    const props = { c: cls, z, a: attr };
    if (cls % 100 >= 40 && cls % 100 < 50) props.col = (colours && colours[attr]) || "";
    if (POLY.has(cls)) {
      const polys = [];
      for (const p of rings) {
        let area = 0;
        for (let i = 0, n = p.length; i < n; i += 2) {
          const j = (i + 2) % n;
          area += p[i] * p[j + 1] - p[j] * p[i + 1];
        }
        const ring = [];
        for (let i = 0; i < p.length; i += 2) ring.push(toLngLat(p[i], p[i + 1]));
        if (ring.length < 3) continue;
        ring.push(ring[0]);
        if (area > 0 || !polys.length) polys.push([ring]); else polys[polys.length - 1].push(ring);
      }
      if (polys.length) out.push({ type: "Feature", properties: props, geometry: polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys } });
    } else {
      const lines = rings.filter((p) => p.length >= 4).map((p) => {
        const l = [];
        for (let i = 0; i < p.length; i += 2) l.push(toLngLat(p[i], p[i + 1]));
        return l;
      });
      if (lines.length) out.push({ type: "Feature", properties: props, geometry: lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines } });
    }
    return out;
  }

  // ------------------------------------------------------------------ palettes
  // 夜: a monochrome midnight indigo, water darkest, blocks and streets in
  // steps of light, so only the lanterns (and the rail lines) carry colour.
  // 昼: white ground and footprints drawn like a residential map.
  const PAL = {
    night: {
      bg: "#161e2d", park: "#142420", forest: "#13221e", cemetery: "#172220", grass: "#15261f", water: "#0b111c", river: "#0d1522",
      bld: "#1c2537", bldLine: "#2b354b", bldShadow: "rgba(3,6,12,.6)",
      minor: "#232d40", ped: "#283247", tert: "#2b364c", sec: "#323e56", pri: "#3b4862", mot: "#46546f",
      cas: "#141b29", tunnel: "#232c3d", path: "#36425a", admin: "#2f3a52", pref: "#3e4a68",
      rail: "#5d6a85", railTun: 0.25, railOp: 0.6, railCase: "#161e2d",
      text: "#ece8e1", halo: "#131a28", yomi: "#9099ab", place: "#8a93a6", placeBig: "#b6becd", parkText: "#6f9488",
      station: "#ece8e1", stationRing: "#131a28", sign: "#d9432b", signText: "#fff6e6", signLine: "rgba(255,214,170,.55)",
      poi: "#c08a64", poiText: "#d1a585",
      glow: 0.62, ykFill: 0.11, ykLine: 0.8, dot: "#fff1d0",
    },
    day: {
      bg: "#f4f4f1", park: "#dde8d6", forest: "#d3e0cb", cemetery: "#e5e9e2", grass: "#e1eadb", water: "#cdd9e2", river: "#c3d2dd",
      bld: "#e7e6e1", bldLine: "#d0cec8", bldShadow: "rgba(28,28,27,.07)",
      minor: "#ffffff", ped: "#f0eeea", tert: "#ffffff", sec: "#ffffff", pri: "#ffffff", mot: "#fffcf6",
      cas: "#d6d5d0", tunnel: "#d3d2cd", path: "#a6a5a0", admin: "#bab6c6", pref: "#a7a1b6",
      rail: "#3d3d3b", railTun: 0.35, railOp: 0.6, railCase: "#f4f4f1",
      text: "#1c1c1b", halo: "#f8f8f6", yomi: "#77766f", place: "#6c6b66", placeBig: "#3f3e3a", parkText: "#557550",
      station: "#ffffff", stationRing: "#1c1c1b", sign: "#c8371f", signText: "#fffdf9", signLine: "rgba(28,28,27,.32)",
      poi: "#ad5a3a", poiText: "#8e4a31",
      glow: 0.14, ykFill: 0.1, ykLine: 0.7, dot: "#ffffff",
    },
  };
  // 朱・山吹・群青・若竹・藤・桃
  const KIND_COL = {
    night: { yokocho: "#ff6a4a", senbero: "#f5b844", tachinomi: "#7aa2ff", kakuuchi: "#52c9a0", bar: "#b892f2", social: "#ff7fae" },
    day: { yokocho: "#c8371f", senbero: "#d08a0e", tachinomi: "#2f56b8", kakuuchi: "#18805f", bar: "#7c4cb3", social: "#c93a72" },
  };
  const LIT = { on: 1, unk: 0.45, off: 0 };
  const KIND_GLYPH = { yokocho: "横", senbero: "千", tachinomi: "立", kakuuchi: "角", bar: "酒", social: "交" };

  // zoom → width stops
  const w = (...stops) => ["interpolate", ["exponential", 1.6], ["zoom"], ...stops.flat()];
  const wmap = (stops, f) => w(...stops.map(([z, v]) => [z, f(v)]));
  const ROADS = [
    { id: "service", c: [27], minz: 16, fill: "minor", st: [[16, 1], [18, 4], [20, 12]] },
    { id: "minor", c: [25], minz: 13.5, fill: "minor", st: [[13.5, 0.4], [15, 1.2], [17, 4.5], [19, 13], [20, 20]] },
    { id: "ped", c: [26], minz: 14, fill: "ped", st: [[14, 0.6], [16, 2.4], [18, 8], [20, 20]] },
    { id: "tert", c: [24], minz: 12.5, fill: "tert", st: [[12.5, 0.6], [14, 1.6], [16, 4.6], [18, 11], [20, 26]] },
    { id: "sec", c: [23], minz: 11, fill: "sec", st: [[11, 0.6], [13, 1.4], [15, 3.6], [17, 8], [19, 18], [20, 28]] },
    { id: "pri", c: [22, 21], minz: 9, fill: "pri", st: [[9, 0.5], [11, 1], [13, 2.2], [15, 4.6], [17, 10], [19, 22], [20, 32]] },
    { id: "mot", c: [20], minz: 8, fill: "mot", st: [[8, 0.6], [11, 1.4], [13, 2.6], [15, 5.4], [17, 11], [19, 24], [20, 34]] },
  ];

  function baseLayers(src, P, lo) {
    const L = [];
    const z = (a, b) => (lo ? { maxzoom: 12.5, ...(a != null ? { minzoom: a } : {}) } : { minzoom: Math.max(12.5, b == null ? 12.5 : b) });
    const only = (...c) => ["in", ["get", "c"], ["literal", c]];
    const minz = ["<=", ["get", "z"], ["+", ["zoom"], 0.5]];
    L.push({ id: `${src}-green`, type: "fill", source: src, ...z(), filter: ["all", only(2, 3, 4, 5), minz],
      paint: { "fill-color": ["match", ["get", "c"], 3, P.forest, 4, P.cemetery, 5, P.grass, P.park], "fill-antialias": true } });
    L.push({ id: `${src}-river`, type: "line", source: src, ...z(), filter: only(10),
      paint: { "line-color": P.river, "line-width": w([10, 0.6], [14, 2], [18, 8]) } });
    L.push({ id: `${src}-stream`, type: "line", source: src, ...z(), filter: only(11),
      paint: { "line-color": P.river, "line-width": w([12, 0.4], [16, 1.4], [18, 3]) } });
    L.push({ id: `${src}-water`, type: "fill", source: src, ...z(), filter: ["all", only(1), minz], paint: { "fill-color": P.water } });
    L.push({ id: `${src}-admin`, type: "line", source: src, ...z(null, 12.5), maxzoom: 15.5, filter: only(50, 51),
      paint: { "line-color": ["match", ["get", "c"], 51, P.pref, P.admin], "line-width": ["match", ["get", "c"], 51, 1.4, 0.9], "line-dasharray": [3, 2.5] } });
    return L;
  }

  function roadLayers(src, P, lo) {
    const L = [];
    const zr = (r) => (lo ? { minzoom: Math.min(r.minz, 12.4), maxzoom: 12.5 } : { minzoom: Math.max(12.5, r.minz) });
    const minz = ["<=", ["get", "z"], ["+", ["zoom"], 0.5]];
    for (const r of ROADS) {
      if (lo && r.minz > 12.4) continue;
      L.push({ id: `${src}-${r.id}-tun`, type: "line", source: src, ...zr(r), filter: ["all", ["in", ["get", "c"], ["literal", r.c.map((c) => c + 100)]], minz],
        paint: { "line-color": P.tunnel, "line-width": wmap(r.st, (v) => v * 0.55), "line-dasharray": [2, 2], "line-opacity": 0.8 } });
    }
    for (const r of ROADS) {
      if (lo && r.minz > 12.4) continue;
      L.push({ id: `${src}-${r.id}-case`, type: "line", source: src, ...zr(r), minzoom: Math.max(zr(r).minzoom || 0, 13.5), filter: ["all", ["in", ["get", "c"], ["literal", r.c]], minz],
        layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": P.cas, "line-width": wmap(r.st, (v) => v + 1.6), "line-opacity": 0.9 } });
    }
    for (const r of ROADS) {
      if (lo && r.minz > 12.4) continue;
      L.push({ id: `${src}-${r.id}`, type: "line", source: src, ...zr(r), filter: ["all", ["in", ["get", "c"], ["literal", r.c]], minz],
        layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": P[r.fill], "line-width": w(...r.st) } });
    }
    return L;
  }

  function railLayers(src, P, lo) {
    const z = lo ? { maxzoom: 12.5 } : { minzoom: 12.5 };
    const col = ["case", ["!=", ["get", "col"], ""], ["get", "col"], P.rail];
    const RW = [[8, 0.7], [11, 1.2], [13, 1.8], [15, 2.8], [17, 4], [19, 5.6]];
    const width = w(...RW);
    return [
      { id: `${src}-rail-tun`, type: "line", source: src, ...z, filter: [">=", ["get", "c"], 140],
        paint: { "line-color": col, "line-width": wmap(RW, (v) => v * 0.8), "line-opacity": P.railTun, "line-dasharray": [2.2, 1.6] } },
      { id: `${src}-rail-case`, type: "line", source: src, ...z, filter: ["all", [">=", ["get", "c"], 40], ["<", ["get", "c"], 50]],
        layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": P.railCase, "line-width": wmap(RW, (v) => v + 2), "line-opacity": 0.85 } },
      { id: `${src}-rail`, type: "line", source: src, ...z, filter: ["all", [">=", ["get", "c"], 40], ["<", ["get", "c"], 50]],
        layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": col, "line-width": width, "line-opacity": P.railOp } },
    ];
  }

  function streetLayers(src, P) {
    const minz = ["<=", ["get", "z"], ["+", ["zoom"], 0.5]];
    return [
      ...roadLayers(src, P, false).filter((l) => /-(minor|ped|tert)(-|$)/.test(l.id)),
      { id: `${src}-poi`, type: "circle", source: src, minzoom: 15.5, filter: ["==", ["get", "c"], 90],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 15.5, 1.2, 18, 2.8], "circle-color": P.poi, "circle-opacity": 0.55, "circle-stroke-color": P.bg, "circle-stroke-width": 0.8 } },
    ];
  }

  function detailLayers(src, P) {
    return [
      { id: `${src}-path`, type: "line", source: src, minzoom: 15.5, filter: ["in", ["get", "c"], ["literal", [28, 128]]],
        paint: { "line-color": P.path, "line-width": w([15.5, 0.6], [18, 1.6], [20, 3]), "line-dasharray": [1.6, 1.2] } },
      { id: `${src}-steps`, type: "line", source: src, minzoom: 16, filter: ["in", ["get", "c"], ["literal", [29, 129]]],
        paint: { "line-color": P.path, "line-width": w([16, 2], [19, 5]), "line-dasharray": [0.4, 0.5] } },
      { id: `${src}-service`, type: "line", source: src, minzoom: 16, filter: ["==", ["get", "c"], 27],
        layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": P.minor, "line-width": w([16, 1], [18, 4], [20, 12]) } },
      // footprints, not boxes: a soft offset shadow, the fill, then a hairline
      { id: `${src}-bldsh`, type: "fill", source: src, minzoom: 15, filter: ["==", ["get", "c"], 6],
        paint: { "fill-color": P.bldShadow, "fill-translate": [1.2, 1.8], "fill-translate-anchor": "viewport", "fill-antialias": false,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.8, 1] } },
      { id: `${src}-bld`, type: "fill", source: src, minzoom: 15, filter: ["==", ["get", "c"], 6],
        paint: { "fill-color": P.bld, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.6, 1] } },
      { id: `${src}-bldline`, type: "line", source: src, minzoom: 15.4, filter: ["==", ["get", "c"], 6],
        paint: { "line-color": P.bldLine, "line-width": ["interpolate", ["linear"], ["zoom"], 15.4, 0.3, 17, 0.6, 19, 1.1],
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 15.4, 0, 16, 1] } },
    ];
  }

  // ------------------------------------------------------------------ the atlas
  class Atlas {
    constructor(el, opts) {
      this.el = el;
      this.o = opts;
      this.theme = opts.theme || "night";
      this.P = PAL[this.theme];
      this.KC = KIND_COL[this.theme];
      this.spots = opts.spots;
      this.lit = new Map();      // id -> "on" | "off" | "unk" (open now / outside its hours / hours unknown); missing = on
      this.selected = null;
      this.hover = null;
      this.labels = new Map();   // cell -> labels
      this.pois = [];
      this.chunks = {};
      this.chunkOrder = [];
      this.colours = [];
      this.visibleIds = new Set(this.spots.map((s) => s.id));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.three = !!opts.three;
      this.ready = false;
      const P = this.P;
      this.map = new maplibregl.Map({
        container: el,
        style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": P.bg } },
          ...["anchor-hi-ground", "anchor-streets", "anchor-hi-roads", "anchor-detail", "anchor-spots", "anchor-3d"].map((id) => ({ id, type: "background", layout: { visibility: "none" }, paint: {} }))] },
        bounds: opts.bounds, fitBoundsOptions: { padding: opts.padding ? opts.padding() : 40 },
        maxBounds: [[139.0, 35.3], [140.25, 36.0]], minZoom: 8.5, maxZoom: 19.5,
        pitch: this.three ? 42 : 0, maxPitch: 70, antialias: true, attributionControl: false,
        dragRotate: true, pitchWithRotate: true, touchPitch: true, fadeDuration: 0,
        preserveDrawingBuffer: !!opts.capture,
      });
      this.map.touchZoomRotate.enableRotation();
      this.ov = document.createElement("canvas");
      this.ov.className = "nb-overlay";
      this.map.getCanvasContainer().insertBefore(this.ov, this.map.getCanvas().nextSibling);
      this.map.on("load", () => this._init());
      this.map.on("render", () => this._schedule());
      this.map.on("resize", () => this._schedule());
      this.map.on("moveend", () => this._need());
    }

    // -------------------------------------------------------------- loading
    async _init() {
      const m = this.map, url = this.o.dataUrl || "data/";
      m.addSource("spots", { type: "geojson", data: this._spotGeo() });
      m.addSource("yk", { type: "geojson", data: this._ykGeo() });
      this._addSpotLayers();
      let base;
      try {
        base = await fetch(url + "base.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
      } catch (e) {
        this.o.onError && this.o.onError(e);
        return;
      }
      this.colours = base.colours || [];
      const lo = [];
      base.lo.forEach((r) => toGeo(r, null, this.colours, lo));
      m.addSource("lo", { type: "geojson", data: { type: "FeatureCollection", features: lo }, maxzoom: 12, tolerance: 0.45 });
      [...baseLayers("lo", this.P, true), ...roadLayers("lo", this.P, true), ...railLayers("lo", this.P, true)].forEach((l) => m.addLayer(l, "anchor-hi-ground"));
      base.labels.forEach((l) => this._addLabel(l[0], l[1], l[2], l[3], l[4], l[5], l[6]));
      this.ready = true;
      this._loadFont();
      this._need();
      this._schedule();
      this.o.onReady && this.o.onReady();
    }

    async _loadHi() {
      if (this.hiState) return;
      this.hiState = "loading";
      try {
        const d = await fetch((this.o.dataUrl || "data/") + "base_hi.json").then((r) => r.json());
        const f = [];
        d.hi.forEach((r) => toGeo(r, null, this.colours, f));
        const m = this.map;
        m.addSource("hi", { type: "geojson", data: { type: "FeatureCollection", features: f }, maxzoom: 16, tolerance: 0.4 });
        baseLayers("hi", this.P, false).forEach((l) => m.addLayer(l, "anchor-streets"));
        [...roadLayers("hi", this.P, false).filter((l) => !/-(minor|ped|tert|service)(-|$)/.test(l.id)), ...railLayers("hi", this.P, false)].forEach((l) => m.addLayer(l, "anchor-detail"));
        this.hiState = "done";
      } catch (e) { this.hiState = null; }
    }

    _need() {
      if (!this.ready) return;
      const z = this.map.getZoom();
      if (z >= 12) this._loadHi();
      if (z < 12.8) return;
      const b = this.map.getBounds();
      const [x0, y1] = fromLngLat(b.getWest(), b.getSouth());
      const [x1, y0] = fromLngLat(b.getEast(), b.getNorth());
      const want = [];
      for (const layer of z >= 14.6 ? ["c", "b"] : ["c"]) {
        const sz = SIZE[layer], idx = (this.o.chunks || {})[layer] || {};
        for (let x = Math.floor(x0 / sz); x <= Math.floor(x1 / sz); x++) {
          for (let y = Math.floor(y0 / sz); y <= Math.floor(y1 / sz); y++) {
            const key = `${x}_${y}`;
            if (key in idx) want.push(layer + "/" + key);
          }
        }
      }
      want.forEach((id) => this._loadChunk(id));
      this._evict(new Set(want));
    }

    async _loadChunk(id) {
      if (this.chunks[id]) { this._touch(id); return; }
      this.chunks[id] = { state: "loading" };
      try {
        const d = await fetch((this.o.dataUrl || "data/") + id + ".json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
        const f = [], o = d.o;
        d.f.forEach((r) => toGeo(r, o, this.colours, f));
        (d.p || []).forEach((p) => {
          const ll = toLngLat(p[0] + o[0], p[1] + o[1]);
          f.push({ type: "Feature", properties: { c: 90, n: p[2], k: p[3], osm: p[4], h: p[5] || "", lv: p[6] || "", ck: p[7] || "" }, geometry: { type: "Point", coordinates: ll } });
          this.pois.push({ x: p[0] + o[0], y: p[1] + o[1], n: p[2], k: p[3], osm: p[4], h: p[5], lv: p[6], ck: p[7], chunk: id });
        });
        (d.l || []).forEach((l) => this._addLabel(l[0], l[1], l[2] + o[0], l[3] + o[1], l[4], l[5], "", id));
        const m = this.map, sid = id.replace("/", ":");
        if (!m.getSource(sid)) {
          m.addSource(sid, { type: "geojson", data: { type: "FeatureCollection", features: f }, maxzoom: 16, tolerance: 0.3, buffer: 64 });
          const isB = id[0] === "b";
          const layers = (isB ? detailLayers(sid, this.P) : streetLayers(sid, this.P));
          // streets sit under the main roads; paths and building footprints under the spots; extrusions on top
          // footprints sit on the ground under every street; paths and steps above the roads
          layers.forEach((l) => m.addLayer(l, !isB ? (l.id.endsWith("-poi") ? "anchor-spots" : "anchor-hi-roads") : /-bld(sh|line)?$/.test(l.id) ? "anchor-streets" : "anchor-detail"));
          this.chunks[id] = { state: "done", layers: layers.map((l) => l.id), sid };
          this._touch(id);
        }
        this._schedule();
      } catch (e) {
        delete this.chunks[id];
      }
    }

    _touch(id) { this.chunkOrder = this.chunkOrder.filter((x) => x !== id); this.chunkOrder.push(id); }
    _evict(keep) {
      const max = 18;
      while (this.chunkOrder.length > max) {
        const id = this.chunkOrder.find((x) => !keep.has(x));
        if (!id) break;
        const c = this.chunks[id];
        this.chunkOrder = this.chunkOrder.filter((x) => x !== id);
        if (c && c.layers) {
          c.layers.forEach((l) => this.map.getLayer(l) && this.map.removeLayer(l));
          this.map.getSource(c.sid) && this.map.removeSource(c.sid);
        }
        delete this.chunks[id];
        this.pois = this.pois.filter((p) => p.chunk !== id);
        this.labels.forEach((arr, k) => this.labels.set(k, arr.filter((l) => l.chunk !== id)));
      }
    }

    // -------------------------------------------------------------- spots
    _spotGeo() {
      return { type: "FeatureCollection", features: this.spots.filter((s) => this.visibleIds.has(s.id)).map((s) => ({
        type: "Feature", properties: { id: s.id, k: s.kind, s: s.social || 0, st: s.status, on: LIT[this.lit.get(s.id) || "on"] },
        geometry: { type: "Point", coordinates: [s.lng, s.lat] } })) };
    }
    _ykGeo() {
      const f = [];
      for (const s of this.spots) {
        if (!s.shape || !this.visibleIds.has(s.id)) continue;
        const parts = s.shape.p.map((e) => {
          const a = dec(e), l = [];
          for (let i = 0; i < a.length; i += 2) l.push(toLngLat(a[i], a[i + 1]));
          return l;
        });
        if (s.shape.t === "poly") parts.forEach((r) => { r.push(r[0]); f.push({ type: "Feature", properties: { id: s.id, t: "p" }, geometry: { type: "Polygon", coordinates: [r] } }); });
        else f.push({ type: "Feature", properties: { id: s.id, t: "l" }, geometry: { type: "MultiLineString", coordinates: parts } });
      }
      return { type: "FeatureCollection", features: f };
    }
    _addSpotLayers() {
      const m = this.map, P = this.P, K = this.KC;
      const kc = ["match", ["get", "k"], "yokocho", K.yokocho, "senbero", K.senbero, "tachinomi", K.tachinomi, "kakuuchi", K.kakuuchi, "bar", K.bar, K.social];
      m.addLayer({ id: "spot-glow", type: "circle", source: "spots", filter: ["all", ["!=", ["get", "st"], "closed"], [">", ["get", "on"], 0]],
        paint: {
          "circle-color": kc, "circle-blur": 1, "circle-pitch-alignment": "map",
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 9, ["*", 1.6, ["+", 3, ["get", "s"]]], 13, ["*", 5, ["+", 3, ["get", "s"]]], 15, ["*", 8, ["+", 2, ["get", "s"]]], 18, ["*", 13, ["+", 2, ["get", "s"]]]],
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 9, ["*", P.glow * 1.1, ["get", "on"]], 13, ["*", P.glow, ["get", "on"]],
            16, ["*", P.glow * 0.75, ["get", "on"]], 18, ["*", P.glow * 0.6, ["get", "on"]]],
        } }, "anchor-spots");
      m.addLayer({ id: "yk-fill", type: "fill", source: "yk", minzoom: 13.5, filter: ["==", ["get", "t"], "p"], paint: { "fill-color": K.yokocho, "fill-opacity": P.ykFill } }, "anchor-spots");
      m.addLayer({ id: "yk-line", type: "line", source: "yk", minzoom: 13.5,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": K.yokocho, "line-opacity": ["case", ["==", ["get", "t"], "l"], P.ykLine * 0.55, P.ykLine], "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 13.5, ["case", ["==", ["get", "t"], "l"], 3, 1], 17, ["case", ["==", ["get", "t"], "l"], 12, 2], 19, ["case", ["==", ["get", "t"], "l"], 30, 2.4]], "line-blur": ["case", ["==", ["get", "t"], "l"], 2, 0] } }, "anchor-spots");
      m.addLayer({ id: "spot-dot", type: "circle", source: "spots", maxzoom: 13.2,
        paint: {
          "circle-color": kc, "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.8, 13, ["+", 2.4, ["*", 0.4, ["get", "s"]]]],
          "circle-stroke-color": P.dot, "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 13, 1.2],
          "circle-opacity": ["case", ["==", ["get", "st"], "closed"], 0.35, ["==", ["get", "on"], 0], 0.42, 1],
          "circle-stroke-opacity": ["case", ["==", ["get", "st"], "closed"], 0.35, ["==", ["get", "on"], 0], 0.42, 1],
        } });
    }
    setVisible(ids) {
      this.visibleIds = new Set(ids);
      if (!this.map.getSource("spots")) return;
      this.map.getSource("spots").setData(this._spotGeo());
      this.map.getSource("yk").setData(this._ykGeo());
      this._schedule();
    }
    select(id) { this.selected = id; this._schedule(); }
    /** lit: Map id -> "on" | "off" | "unk"; lanterns and glows follow it */
    setLit(lit) {
      const key = [...lit].map(([k, v]) => k + v).join();
      if (key === this._litKey) return;
      this._litKey = key;
      this.lit = lit;
      if (this.map.getSource("spots")) this.map.getSource("spots").setData(this._spotGeo());
      this._schedule();
    }
    setHover(id) { if (this.hover !== id) { this.hover = id; this._schedule(); } }

    // -------------------------------------------------------------- theme
    setTheme(theme) {
      if (theme === this.theme) return;
      this.theme = theme;
      this.P = PAL[theme];
      this.KC = KIND_COL[theme];
      const m = this.map;
      if (!m.isStyleLoaded()) return;
      m.setPaintProperty("bg", "background-color", this.P.bg);
      const ids = m.getStyle().layers.map((l) => l.id);
      const fresh = {};
      const collect = (arr) => arr.forEach((l) => { fresh[l.id.replace(/^[^-]+-/, "")] = l; });
      ["lo", "hi"].forEach((s) => { collect(baseLayers(s, this.P, s === "lo")); collect(roadLayers(s, this.P, s === "lo")); collect(railLayers(s, this.P, s === "lo")); });
      collect(streetLayers("x", this.P)); collect(detailLayers("x", this.P));
      for (const id of ids) {
        const key = id.replace(/^[^-]+-/, "");
        const spec = fresh[key];
        if (!spec || !spec.paint) continue;
        for (const [k, v] of Object.entries(spec.paint)) {
          try { m.setPaintProperty(id, k, v); } catch (e) { /* layer type mismatch */ }
        }
      }
      ["spot-glow", "yk-fill", "yk-line", "spot-dot"].forEach((l) => m.getLayer(l) && m.removeLayer(l));
      this._addSpotLayers();
      this._sprites = null;
      this._schedule();
    }

    // -------------------------------------------------------------- labels
    _addLabel(t, minz, x, y, n, r, yomi, chunk) {
      const key = Math.floor(x / 8192) * 100000 + Math.floor(y / 8192);
      let a = this.labels.get(key);
      if (!a) { a = []; this.labels.set(key, a); }
      a.push({ t, z: minz, x, y, n, r: r || 0, yomi: yomi || "", chunk, ll: toLngLat(x, y) });
    }
    _labelsIn(x0, y0, x1, y1) {
      const out = [];
      for (let gx = Math.floor(x0 / 8192); gx <= Math.floor(x1 / 8192); gx++) {
        for (let gy = Math.floor(y0 / 8192); gy <= Math.floor(y1 / 8192); gy++) {
          const a = this.labels.get(gx * 100000 + gy);
          if (a) for (const l of a) if (l.x >= x0 && l.x <= x1 && l.y >= y0 && l.y <= y1) out.push(l);
        }
      }
      return out;
    }
    // Mincho glyphs for spot names, signs and ward names; with opts.webSans
    // (headless capture) the small labels get BIZ UDPGothic too.
    _loadFont() {
      if (!document.fonts || !document.fonts.load) return;
      const serif = new Set(), sans = new Set();
      this.spots.forEach((s) => { for (const ch of s.name) serif.add(ch); });
      Object.values(KIND_GLYPH).forEach((g) => serif.add(g));
      this.labels.forEach((a) => a.forEach((l) => {
        const target = l.t === "p" && l.r >= 3 ? serif : sans;
        for (const ch of l.n + l.yomi) target.add(ch);
      }));
      const jobs = [document.fonts.load(`800 13px "Shippori Mincho B1"`, [...serif].join(""))];
      if (this.o.webSans) {
        SANS = '"BIZ UDPGothic",' + SANS;
        jobs.push(document.fonts.load(`700 12px "BIZ UDPGothic"`, [...sans].join("")), document.fonts.load(`400 11px "BIZ UDPGothic"`, [...sans].join("")));
      }
      Promise.all(jobs).then(() => { this._sprites = null; this.fontsReady = true; this._schedule(); }).catch(() => {});
    }

    _schedule() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
    }

    // lantern sprites per kind / state, drawn once per theme
    // mode: "on" lit, "unk" hours unknown (a faint glow), "off" outside its hours (unlit), "closed" closed for good
    _sprite(kind, big, mode) {
      this._sprites = this._sprites || {};
      const key = kind + (big ? "B" : "") + mode;
      if (this._sprites[key]) return this._sprites[key];
      const d = this.dpr, s = big ? 1.35 : 1;
      const bw = 20 * s, bh = 25 * s, pad = 14 * s;
      const c = document.createElement("canvas");
      c.width = Math.ceil((bw + pad * 2) * d); c.height = Math.ceil((bh + pad * 2) * d);
      const x = c.getContext("2d");
      x.scale(d, d);
      const col = this.KC[kind] || this.KC.bar;
      const cx = pad + bw / 2, cy = pad + bh / 2;
      const lit = mode === "on" || mode === "unk";
      if (this.theme === "night" && lit) {
        const g = x.createRadialGradient(cx, cy, 2, cx, cy, bw * 1.15);
        g.addColorStop(0, col + (mode === "on" ? "aa" : "40")); g.addColorStop(1, col + "00");
        x.fillStyle = g; x.fillRect(0, 0, bw + pad * 2, bh + pad * 2);
      } else if (this.theme !== "night") {
        x.shadowColor = "rgba(20,24,32,.35)"; x.shadowBlur = 4 * s; x.shadowOffsetY = 1.5 * s;
      }
      // body
      x.beginPath();
      x.ellipse(cx, cy, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      x.fillStyle = col; x.fill();
      x.shadowColor = "transparent";
      // ribs
      x.save(); x.clip();
      x.strokeStyle = "rgba(0,0,0,.14)"; x.lineWidth = 1 * s;
      for (let i = -2; i <= 2; i++) { x.beginPath(); x.moveTo(cx - bw, cy + i * 4.6 * s); x.lineTo(cx + bw, cy + i * 4.6 * s); x.stroke(); }
      const hl = x.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
      hl.addColorStop(0, "rgba(255,255,255,.0)"); hl.addColorStop(0.32, "rgba(255,255,255,.26)"); hl.addColorStop(0.6, "rgba(255,255,255,0)");
      x.fillStyle = hl; x.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
      x.restore();
      // caps
      x.fillStyle = this.theme === "night" ? "#0b0e14" : "#20242d";
      const capW = bw * 0.56, capH = 3.2 * s;
      x.fillRect(cx - capW / 2, cy - bh / 2 - capH * 0.45, capW, capH);
      x.fillRect(cx - capW / 2, cy + bh / 2 - capH * 0.55, capW, capH);
      // glyph
      x.fillStyle = kind === "senbero" ? "#2a1a03" : "#ffffff";
      x.font = `800 ${12.5 * s}px ${SERIF}`;
      x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText(KIND_GLYPH[kind] || "酒", cx, cy + 0.8 * s);
      if (mode === "closed") { x.globalCompositeOperation = "source-atop"; x.fillStyle = "rgba(128,128,128,.55)"; x.fillRect(0, 0, c.width, c.height); }
      if (mode === "off") {  // an unlit paper lantern: the colour sinks into the dark, the glyph fades
        x.globalCompositeOperation = "source-atop";
        x.fillStyle = this.theme === "night" ? "rgba(14,19,30,.66)" : "rgba(236,236,232,.62)";
        x.fillRect(0, 0, c.width, c.height);
        x.globalCompositeOperation = "source-over";
        x.beginPath(); x.ellipse(cx, cy, bw / 2 - 0.4, bh / 2 - 0.4, 0, 0, Math.PI * 2);
        x.strokeStyle = this.theme === "night" ? col + "66" : col + "88"; x.lineWidth = 1 * s; x.stroke();
      }
      const sp = { c, w: c.width / d, h: c.height / d, bw, bh };
      this._sprites[key] = sp;
      return sp;
    }

    // a vertical sign hanging just right of the lantern, its foot level with it
    _signBox(text, x, y, fs) {
      const n = [...text].length, h = n * fs * 1.04 + 10, w = fs + 9;
      return [x, y + 6 - h, x + w, y + 6];
    }
    _sign(ctx, text, b, fs) {
      const P = this.P, w2 = b[2] - b[0], h = b[3] - b[1];
      ctx.save();
      if (this.theme === "day") { ctx.shadowColor = "rgba(36,32,27,.28)"; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1; }
      else { ctx.shadowColor = "rgba(255,106,74,.55)"; ctx.shadowBlur = 10; }
      ctx.fillStyle = P.sign;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b[0], b[1], w2, h, 3); else ctx.rect(b[0], b[1], w2, h);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = P.signLine; ctx.lineWidth = 0.8;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b[0] + 2, b[1] + 2.5, w2 - 4, h - 5, 2); else ctx.rect(b[0] + 2, b[1] + 2.5, w2 - 4, h - 5);
      ctx.stroke();
      ctx.fillStyle = P.signText; ctx.font = `800 ${fs}px ${SERIF}`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const cx = b[0] + w2 / 2;
      [...text].forEach((ch, i) => {
        const cy = b[1] + 5.5 + fs * 1.04 * (i + 0.5);
        if (VROT.has(ch) || /[A-Za-z]/.test(ch)) { ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 2); ctx.fillText(ch, 0, 0); ctx.restore(); }
        else ctx.fillText(ch, cx, cy);
      });
      ctx.textAlign = "left";
    }

    _draw() {
      const m = this.map, cv = this.ov, d = this.dpr;
      const W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight;
      if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) {
        cv.width = Math.round(W * d); cv.height = Math.round(H * d);
        cv.style.width = W + "px"; cv.style.height = H + "px";
      }
      const ctx = cv.getContext("2d");
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!this.ready) return;
      const z = m.getZoom(), P = this.P;
      const bnd = m.getBounds();
      const [x0, y1] = fromLngLat(bnd.getWest(), bnd.getSouth());
      const [x1, y0] = fromLngLat(bnd.getEast(), bnd.getNorth());
      const boxes = [];
      const lboxes = [];   // lanterns: shop names avoid them, yokocho signs may overlap them
      const hitsAny = (b, list) => { for (const o of list) if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true; return false; };
      const free = (b) => !hitsAny(b, boxes);
      const freeAll = (b) => !hitsAny(b, boxes) && !hitsAny(b, lboxes);
      const inView = (p) => p.x > -60 && p.x < W + 60 && p.y > -40 && p.y < H + 40;
      this.hits = [];

      // curated spots first so they win collisions
      const lanternZ = 13.2, nameZ = 15.6;
      const spots = [];
      if (z >= lanternZ) {
        for (const s of this.spots) {
          if (!this.visibleIds.has(s.id) && s.id !== this.selected) continue;
          const p = m.project([s.lng, s.lat]);
          if (!inView(p)) continue;
          spots.push({ s, p });
        }
        spots.sort((a, b) => (a.s.id === this.selected) - (b.s.id === this.selected) || a.p.y - b.p.y);
      }
      const scale = Math.max(0.62, Math.min(1, (z - lanternZ) / 2.2 + 0.62));
      for (const { s, p } of spots) {
        const big = s.id === this.selected || s.id === this.hover;
        const sp = this._sprite(s.kind, big, s.status === "closed" ? "closed" : this.lit.get(s.id) || "on");
        const k = big ? 1 : scale;
        const wv = sp.w * k, hv = sp.h * k;
        ctx.drawImage(sp.c, p.x - wv / 2, p.y - hv / 2 - sp.bh * k * 0.35, wv, hv);
        const r = sp.bw * k / 2 + 2;
        lboxes.push([p.x - r, p.y - sp.bh * k * 0.9, p.x + r, p.y + sp.bh * k * 0.25]);
        this.hits.push({ x: p.x, y: p.y - sp.bh * k * 0.35, r: Math.max(12, r + 3), spot: s });
        if (s.id === this.selected) {
          ctx.beginPath();
          ctx.ellipse(p.x, p.y + 1, 15, 6, 0, 0, Math.PI * 2);
          ctx.strokeStyle = this.KC[s.kind]; ctx.lineWidth = 2; ctx.stroke();
        }
      }
      // yokocho: vertical vermilion signs, like the ones over an alley entrance
      if (z >= 12.6) {
        for (const { s, p } of spots) {
          if (s.kind !== "yokocho") continue;
          const sel = s.id === this.selected || s.id === this.hover;
          const fs = sel ? 14 : z >= 15 ? 13 : 11.5;
          const b = this._signBox(s.name, p.x + 11 * scale, p.y - 6 * scale, fs);
          if (!sel && !free(b)) continue;
          boxes.push(b);
          this._sign(ctx, s.name, b, fs);
          this.hits.push({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, r: Math.max(14, (b[3] - b[1]) / 2), spot: s });
        }
      }
      // shop names
      if (z >= nameZ || this.selected || this.hover) {
        ctx.textBaseline = "middle";
        for (const { s, p } of spots) {
          if (s.kind === "yokocho") continue;
          const sel = s.id === this.selected || s.id === this.hover;
          if (z < nameZ && !sel) continue;
          ctx.font = `800 ${sel ? 14 : 12.5}px ${SERIF}`;
          const tw = ctx.measureText(s.name).width;
          const tx = p.x + 13 * scale + 3, ty = p.y - 9 * scale;
          const b = [tx - 3, ty - 10, tx + tw + 5, ty + 10];
          if (!sel && !freeAll(b.map((v, i) => (i === 0 ? v + 4 : v)))) continue;
          boxes.push(b);
          if (sel) {
            ctx.fillStyle = P.halo; ctx.globalAlpha = 0.92; ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); ctx.globalAlpha = 1;
            ctx.fillStyle = this.KC[s.kind]; ctx.fillRect(b[0], b[1], 2.5, b[3] - b[1]);
          } else {
            ctx.lineJoin = "round"; ctx.lineWidth = 3.6; ctx.strokeStyle = P.halo; ctx.strokeText(s.name, tx, ty);
          }
          ctx.fillStyle = P.text; ctx.fillText(s.name, tx + (sel ? 2 : 0), ty + 0.5);
        }
      }

      // stations, places, parks
      const zi = Math.floor(z + 0.35);
      const cands = this._labelsIn(x0, y0, x1, y1).filter((l) => l.z <= zi);
      const prio = (l) => (l.t === "s" ? 100 + l.r * 10 : l.t === "p" ? 40 + l.r * 15 : 30);
      cands.sort((a, b) => prio(b) - prio(a));
      for (const l of cands) {
        const p = m.project(l.ll);
        if (!inView(p)) continue;
        if (l.t === "s") {
          // station: a ringed dot with the name above it and the reading above that
          const fs = (l.r >= 3 ? 13 : l.r === 2 ? 12 : 11) + (z >= 15 ? 1 : 0);
          ctx.font = `700 ${fs}px ${SANS}`;
          const tw = ctx.measureText(l.n).width;
          const yomi = z >= 12.5 && l.yomi ? l.yomi : "";
          ctx.font = `400 8.5px ${SANS}`;
          const yw = yomi ? ctx.measureText(yomi).width : 0;
          const half = Math.max(tw, yw) / 2 + 3;
          const top = p.y - 6 - fs - (yomi ? 11 : 0);
          const b = [p.x - half, top - 2, p.x + half, p.y + 5];
          if (!freeAll(b)) continue;
          boxes.push(b);
          ctx.beginPath(); ctx.arc(p.x, p.y, l.r >= 3 ? 4 : 3.2, 0, Math.PI * 2);
          ctx.fillStyle = P.station; ctx.fill(); ctx.lineWidth = 1.6; ctx.strokeStyle = P.stationRing; ctx.stroke();
          ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.lineJoin = "round";
          if (yomi) {
            ctx.font = `400 8.5px ${SANS}`; ctx.lineWidth = 2.6; ctx.strokeStyle = P.halo;
            ctx.strokeText(yomi, p.x, top + 8); ctx.fillStyle = P.yomi; ctx.fillText(yomi, p.x, top + 8);
          }
          ctx.font = `700 ${fs}px ${SANS}`; ctx.lineWidth = 3.4; ctx.strokeStyle = P.halo;
          ctx.strokeText(l.n, p.x, p.y - 6); ctx.fillStyle = P.text; ctx.fillText(l.n, p.x, p.y - 6);
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
        } else {
          const big = l.r >= 3;
          const fs = l.t === "g" ? 11 : big ? 14 : l.r === 2 ? 12 : l.r === 1 ? 11 : 10;
          const wt = l.t === "g" ? 400 : big ? 700 : l.r === 2 ? 700 : 400;
          const text = big && z < 13.5 ? [...l.n].join(" ") : l.n;
          ctx.font = `${wt} ${fs}px ${big ? SERIF : SANS}`;
          const tw = ctx.measureText(text).width;
          const b = [p.x - tw / 2 - 3, p.y - fs / 2 - 2, p.x + tw / 2 + 3, p.y + fs / 2 + 3];
          if (!freeAll(b)) continue;
          boxes.push(b);
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = P.halo; ctx.strokeText(text, p.x, p.y);
          ctx.fillStyle = l.t === "g" ? P.parkText : big ? P.placeBig : P.place; ctx.fillText(text, p.x, p.y);
          ctx.textAlign = "left";
        }
      }

      // OSM drinking spots (unverified): names from z17; dots are a GL layer
      if (z >= 15.5 && this.o.showPoi && this.o.showPoi()) {
        const skip = this.o.skipPoi || (() => false);
        ctx.font = `400 10.5px ${SANS}`;
        ctx.textBaseline = "middle";
        for (const o of this.pois) {
          if (o.x < x0 || o.x > x1 || o.y < y0 || o.y > y1 || skip(o)) continue;
          const p = m.project(toLngLat(o.x, o.y));
          if (!inView(p)) continue;
          this.hits.push({ x: p.x, y: p.y, r: 8, poi: o });
          if (z < 17) continue;
          const tw = ctx.measureText(o.n).width;
          const b = [p.x + 5, p.y - 7, p.x + 8 + tw, p.y + 7];
          if (!freeAll(b)) continue;
          boxes.push(b);
          ctx.lineWidth = 3; ctx.strokeStyle = P.halo; ctx.strokeText(o.n, p.x + 6, p.y);
          ctx.fillStyle = P.poiText; ctx.fillText(o.n, p.x + 6, p.y);
        }
      }
      this.o.onDraw && this.o.onDraw(z);
    }

    // the curated spot nearest to a screen point, else the nearest OSM spot
    hit(pt) {
      let spot = null, poi = null, ds = Infinity, dp = Infinity;
      for (const h of this.hits || []) {
        const dx = h.x - pt.x, dy = h.y - pt.y, dd = dx * dx + dy * dy;
        if (dd > h.r * h.r) continue;
        if (h.spot && dd < ds) { ds = dd; spot = h; }
        if (h.poi && dd < dp) { dp = dd; poi = h; }
      }
      return spot || poi;
    }

    // -------------------------------------------------------------- camera
    flyToSpot(s, offset) {
      const target = { center: [s.lng, s.lat], zoom: Math.max(this.map.getZoom(), s.kind === "yokocho" ? 16.8 : 17.6), offset: offset || [0, 0], duration: 1600, essential: true };
      if (this.three) { target.pitch = 45; } else { target.pitch = 0; target.bearing = 0; }
      this.map.flyTo(target);
    }
    setThree(on) {
      this.three = on;
      this.map.easeTo({ pitch: on ? 45 : 0, bearing: on ? this.map.getBearing() : 0, duration: 700 });
    }
  }

  window.NBAtlas = { Atlas, toLngLat, fromLngLat, dec, PAL, KIND_COL, KIND_GLYPH };
})();
