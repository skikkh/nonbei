/* 東京のんべえ地図 — vector basemap for Leaflet.
 *
 * The basemap is drawn on canvas tiles from OpenStreetMap data that ships
 * with the page (data/base.json + data/c/{x}_{y}.json street chunks), so it
 * needs no tile server. Coordinates are Web Mercator "world units" at z18
 * (256 * 2^18 px around the globe), polyline-encoded by scripts/geo.py.
 */
(function () {
  "use strict";

  var Z0 = 18;
  var CHUNK = 256 * Math.pow(2, Z0 - 12); // z12 tile, matches scripts/build_chunks.py
  var SIZE = { c: CHUNK, b: CHUNK / 2 };   // street chunks: z12 tiles; building chunks: z13 tiles

  // class codes: keep in sync with scripts/build_basemap.py
  var C = {
    WATER: 1, PARK: 2, FOREST: 3, CEMETERY: 4, GRASS: 5, BUILDING: 6,
    RIVER: 10, STREAM: 11,
    MOTORWAY: 20, TRUNK: 21, PRIMARY: 22, SECONDARY: 23, TERTIARY: 24,
    MINOR: 25, PEDESTRIAN: 26, SERVICE: 27, FOOTWAY: 28, STEPS: 29,
    RAIL_JR: 40, RAIL: 41, SUBWAY: 42, LIGHT: 43,
    WARD: 50, PREF: 51,
    TUNNEL: 100
  };

  // decode one polyline part; deltas run on from (x, y)
  function dec(s, x, y) {
    var out = [], i = 0, n = s.length, r, sh, b;
    x = x || 0; y = y || 0;
    while (i < n) {
      r = 0; sh = 0;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      x += (r & 1) ? ~(r >> 1) : (r >> 1);
      r = 0; sh = 0;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      y += (r & 1) ? ~(r >> 1) : (r >> 1);
      out.push(x, y);
    }
    return Float64Array.from(out);
  }

  // [class, minzoom, part, ...]; each part continues from the previous one, the first from `o`
  function toFeature(raw, o) {
    var parts = [], minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    var cx = o ? o[0] : 0, cy = o ? o[1] : 0;
    for (var k = 2; k < raw.length; k++) {
      var p = dec(raw[k], cx, cy);
      for (var i = 0; i < p.length; i += 2) {
        var x = p[i], y = p[i + 1];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      if (p.length) { cx = p[p.length - 2]; cy = p[p.length - 1]; }
      parts.push(p);
    }
    return { c: raw[0], z: raw[1], p: parts, b: [minx, miny, maxx, maxy] };
  }

  // uniform grid index ---------------------------------------------------------
  function Grid(cell) { this.cell = cell; this.m = new Map(); this.stamp = 0; }
  Grid.prototype.insert = function (f) {
    var c = this.cell;
    var x0 = Math.floor(f.b[0] / c), x1 = Math.floor(f.b[2] / c);
    var y0 = Math.floor(f.b[1] / c), y1 = Math.floor(f.b[3] / c);
    for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) {
      var key = gx * 65536 + gy, a = this.m.get(key);
      if (!a) { a = []; this.m.set(key, a); }
      a.push(f);
    }
    f._s = 0;
  };
  Grid.prototype.query = function (minx, miny, maxx, maxy, z, out) {
    var c = this.cell, s = ++this.stamp;
    var x0 = Math.floor(minx / c), x1 = Math.floor(maxx / c);
    var y0 = Math.floor(miny / c), y1 = Math.floor(maxy / c);
    for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) {
      var a = this.m.get(gx * 65536 + gy);
      if (!a) continue;
      for (var i = 0; i < a.length; i++) {
        var f = a[i];
        if (f._s === s || f.z > z) continue;
        f._s = s;
        var b = f.b;
        if (b[2] < minx || b[0] > maxx || b[3] < miny || b[1] > maxy) continue;
        out.push(f);
      }
    }
    return out;
  };

  // styles ---------------------------------------------------------------------
  function readPalette() {
    var cs = getComputedStyle(document.documentElement);
    var keys = ["land", "park", "forest", "cemetery", "grass", "water", "building", "building-line",
      "road-minor", "road-minor-case", "road-ped", "road-tert", "road-tert-case", "road-sec", "road-sec-case",
      "road-pri", "road-pri-case", "road-mot", "road-mot-case", "road-tunnel", "path", "rail", "rail-gap",
      "subway", "boundary", "label", "label-halo", "label-station", "label-place", "label-park", "poi",
      "station-box", "station-line"];
    var p = {};
    keys.forEach(function (k) { p[k] = cs.getPropertyValue("--map-" + k).trim() || "#888"; });
    return p;
  }

  function lerpW(stops, z) {
    if (z <= stops[0][0]) return stops[0][1] * Math.pow(2, (z - stops[0][0]) * 0.6);
    for (var i = 1; i < stops.length; i++) {
      if (z <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i], t = (z - a[0]) / (b[0] - a[0]);
        return a[1] * Math.pow(b[1] / a[1], t);
      }
    }
    var l = stops[stops.length - 1];
    return l[1] * Math.pow(2, z - l[0]);
  }

  var ROADS = [ // drawn bottom → top
    { c: C.SERVICE, w: [[16, 1.1], [17, 2.4], [18, 4.6], [19, 8]], fill: "road-minor", cas: "road-minor-case", casZ: 17 },
    { c: C.MINOR, w: [[14, 0.55], [15, 1.1], [16, 2.6], [17, 5], [18, 9], [19, 16]], fill: "road-minor", cas: "road-minor-case", casZ: 16 },
    { c: C.PEDESTRIAN, w: [[14, 0.6], [15, 1.2], [16, 2.8], [17, 5.2], [18, 9], [19, 16]], fill: "road-ped", cas: "road-minor-case", casZ: 16 },
    { c: C.TERTIARY, w: [[13, 0.9], [14, 1.8], [15, 2.8], [16, 5], [17, 8], [18, 12], [19, 20]], fill: "road-tert", cas: "road-tert-case", casZ: 14 },
    { c: C.SECONDARY, w: [[12, 0.9], [13, 1.4], [14, 2.4], [16, 6], [18, 13], [19, 22]], fill: "road-sec", cas: "road-sec-case", casZ: 13 },
    { c: C.PRIMARY, w: [[10, 0.7], [11, 1], [12, 1.4], [14, 3.2], [16, 7], [18, 15], [19, 24]], fill: "road-pri", cas: "road-pri-case", casZ: 12 },
    { c: C.TRUNK, w: [[10, 0.9], [12, 1.7], [14, 3.6], [16, 8], [18, 16], [19, 26]], fill: "road-pri", cas: "road-pri-case", casZ: 12 },
    { c: C.MOTORWAY, w: [[10, 1.1], [12, 2], [14, 4], [16, 8.5], [18, 17], [19, 28]], fill: "road-mot", cas: "road-mot-case", casZ: 11 }
  ];
  var RAIL_W = [[10, 1.1], [12, 1.5], [14, 2.4], [16, 3.6], [18, 5.5]];
  var SUB_W = [[10, 0.7], [13, 1.2], [16, 2], [18, 3]];

  function strokeFeats(ctx, feats, ox, oy, s) {
    ctx.beginPath();
    for (var j = 0; j < feats.length; j++) {
      var ps = feats[j].p;
      for (var q = 0; q < ps.length; q++) {
        var p = ps[q];
        ctx.moveTo((p[0] - ox) * s, (p[1] - oy) * s);
        for (var i = 2; i < p.length; i += 2) ctx.lineTo((p[i] - ox) * s, (p[i + 1] - oy) * s);
      }
    }
    ctx.stroke();
  }

  function fillFeats(ctx, feats, ox, oy, s, simplifyPx) {
    ctx.beginPath();
    for (var j = 0; j < feats.length; j++) {
      var ps = feats[j].p;
      for (var q = 0; q < ps.length; q++) {
        var p = ps[q], lx = (p[0] - ox) * s, ly = (p[1] - oy) * s;
        ctx.moveTo(lx, ly);
        for (var i = 2; i < p.length; i += 2) {
          var x = (p[i] - ox) * s, y = (p[i + 1] - oy) * s;
          if (simplifyPx && Math.abs(x - lx) < simplifyPx && Math.abs(y - ly) < simplifyPx && i < p.length - 2) continue;
          ctx.lineTo(x, y); lx = x; ly = y;
        }
        ctx.closePath();
      }
    }
    ctx.fill("nonzero");
  }

  // the store -------------------------------------------------------------------
  function Store(base, chunkIndex, baseUrl) {
    this.baseUrl = baseUrl;
    this.lo = new Grid(CHUNK);
    this.hi = new Grid(CHUNK / 8);
    this.labels = new Grid(CHUNK / 4);
    this.pois = new Grid(CHUNK / 8);
    this.chunkIndex = chunkIndex || {};
    this.chunks = {}; // key -> "loading" | "done"
    var self = this;
    base.lo.forEach(function (r) { self.lo.insert(toFeature(r)); });
    base.hi.forEach(function (r) { self.hi.insert(toFeature(r)); });
    base.labels.forEach(function (l) { self.addLabel(l); });
  }
  Store.prototype.addLabel = function (l) {
    this.labels.insert({ t: l[0], z: l[1], x: l[2], y: l[3], n: l[4], r: l[5], b: [l[2], l[3], l[2], l[3]] });
  };
  Store.prototype.addPoi = function (p) {
    this.pois.insert({ x: p[0], y: p[1], n: p[2], k: p[3], osm: p[4], h: p[5], lv: p[6], ck: p[7], z: 15, b: [p[0], p[1], p[0], p[1]] });
  };
  // load the chunks of `layer` ("c" streets from z13, "b" buildings from z15) covering a box
  Store.prototype.need = function (layer, minx, miny, maxx, maxy, onLoad) {
    var self = this, idx = this.chunkIndex[layer] || {}, sz = SIZE[layer];
    var x0 = Math.floor(minx / sz), x1 = Math.floor(maxx / sz);
    var y0 = Math.floor(miny / sz), y1 = Math.floor(maxy / sz);
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
      var key = x + "_" + y, id = layer + "/" + key;
      if (self.chunks[id] || !(key in idx)) continue;
      self.chunks[id] = "loading";
      (function (id, x, y) {
        fetch(self.baseUrl + id + ".json").then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.json();
        }).then(function (d) {
          var o = d.o;
          d.f.forEach(function (r) { self.hi.insert(toFeature(r, o)); });
          (d.l || []).forEach(function (l) { self.addLabel([l[0], l[1], l[2] + o[0], l[3] + o[1], l[4], l[5]]); });
          (d.p || []).forEach(function (p) { self.addPoi([p[0] + o[0], p[1] + o[1]].concat(p.slice(2))); });
          self.chunks[id] = "done";
          onLoad([x * sz - sz / 4, y * sz - sz / 4, (x + 1.25) * sz, (y + 1.25) * sz]);
        }).catch(function () { self.chunks[id] = null; });
      })(id, x, y);
    }
  };

  // canvas tile layer ----------------------------------------------------------------
  var VectorLayer = L.GridLayer.extend({
    options: { tileSize: 256, updateWhenZooming: false, keepBuffer: 3, className: "nb-base" },

    initialize: function (store, options) {
      L.setOptions(this, options);
      this.store = store;
      this.pal = readPalette();
    },

    refreshPalette: function () {
      this.pal = readPalette();
      this.repaint();
    },

    repaint: function (bounds) {
      for (var k in this._tiles) {
        var t = this._tiles[k];
        if (bounds) {
          var span = 256 * Math.pow(2, Z0 - t.coords.z);
          var tx = t.coords.x * span, ty = t.coords.y * span;
          if (tx > bounds[2] || tx + span < bounds[0] || ty > bounds[3] || ty + span < bounds[1]) continue;
        }
        this._draw(t.el, t.coords);
      }
    },

    createTile: function (coords) {
      var tile = document.createElement("canvas");
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      tile.width = 256 * dpr;
      tile.height = 256 * dpr;
      this._draw(tile, coords);
      return tile;
    },

    _draw: function (canvas, coords) {
      var z = coords.z, pal = this.pal, st = this.store;
      var ctx = canvas.getContext("2d");
      var dpr = canvas.width / 256;
      var span = 256 * Math.pow(2, Z0 - z);
      var s = Math.pow(2, z - Z0) * dpr;
      var ox = coords.x * span, oy = coords.y * span;
      var m = 30 / s * dpr;
      if (z >= 13) {
        var self = this, again = function (b) { self.repaint(b); if (self.onChunk) self.onChunk(); };
        st.need("c", ox, oy, ox + span, oy + span, again);
        if (z >= 15) st.need("b", ox, oy, ox + span, oy + span, again);
      }
      var feats = (z <= 12 ? st.lo : st.hi).query(ox - m, oy - m, ox + span + m, oy + span + m, z, []);
      var by = {};
      for (var i = 0; i < feats.length; i++) (by[feats[i].c] || (by[feats[i].c] = [])).push(feats[i]);
      var get = function (c) { return by[c] || []; };

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = pal.land;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      var simp = z <= 12 ? 0.6 * dpr : 0;

      // land cover
      [[C.GRASS, "grass"], [C.CEMETERY, "cemetery"], [C.FOREST, "forest"], [C.PARK, "park"]].forEach(function (g) {
        var f = get(g[0]);
        if (f.length) { ctx.fillStyle = pal[g[1]]; fillFeats(ctx, f, ox, oy, s, simp); }
      });
      // rivers as lines under the water polygons' edges
      ctx.strokeStyle = pal.water;
      if (get(C.STREAM).length) { ctx.lineWidth = lerpW([[12, 0.5], [16, 1.6], [18, 3]], z) * dpr; strokeFeats(ctx, get(C.STREAM), ox, oy, s); }
      if (get(C.RIVER).length) { ctx.lineWidth = lerpW([[11, 0.7], [14, 1.6], [18, 6]], z) * dpr; strokeFeats(ctx, get(C.RIVER), ox, oy, s); }
      if (get(C.WATER).length) { ctx.fillStyle = pal.water; fillFeats(ctx, get(C.WATER), ox, oy, s, simp); }

      // buildings
      if (z >= 16 && get(C.BUILDING).length) {
        ctx.fillStyle = pal.building;
        fillFeats(ctx, get(C.BUILDING), ox, oy, s, 0);
        if (z >= 17) {
          ctx.strokeStyle = pal["building-line"];
          ctx.lineWidth = 0.8 * dpr;
          var bl = get(C.BUILDING);
          ctx.beginPath();
          for (var j = 0; j < bl.length; j++) for (var q = 0; q < bl[j].p.length; q++) {
            var p = bl[j].p[q];
            ctx.moveTo((p[0] - ox) * s, (p[1] - oy) * s);
            for (var k = 2; k < p.length; k += 2) ctx.lineTo((p[k] - ox) * s, (p[k + 1] - oy) * s);
            ctx.closePath();
          }
          ctx.stroke();
        }
      }

      // boundaries (under roads)
      if (z <= 15) {
        ctx.strokeStyle = pal.boundary;
        if (get(C.WARD).length) {
          ctx.setLineDash([4 * dpr, 3 * dpr]);
          ctx.lineWidth = (z >= 13 ? 1.2 : 0.9) * dpr;
          strokeFeats(ctx, get(C.WARD), ox, oy, s);
        }
        if (get(C.PREF).length) {
          ctx.setLineDash([7 * dpr, 3 * dpr, 1.5 * dpr, 3 * dpr]);
          ctx.lineWidth = 1.8 * dpr;
          strokeFeats(ctx, get(C.PREF), ox, oy, s);
        }
        ctx.setLineDash([]);
      }

      // tunnels: faint dashed
      if (z >= 13) {
        ctx.strokeStyle = pal["road-tunnel"];
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ROADS.forEach(function (r) {
          var f = get(r.c + C.TUNNEL);
          if (!f.length) return;
          ctx.lineWidth = Math.max(0.8, lerpW(r.w, z) * 0.55) * dpr;
          strokeFeats(ctx, f, ox, oy, s);
        });
        ctx.setLineDash([]);
      }

      // footpaths and steps
      if (z >= 16) {
        ctx.strokeStyle = pal.path;
        if (get(C.FOOTWAY).length) {
          ctx.setLineDash([2.5 * dpr, 2 * dpr]);
          ctx.lineWidth = lerpW([[16, 0.9], [18, 1.6], [19, 2.2]], z) * dpr;
          strokeFeats(ctx, get(C.FOOTWAY), ox, oy, s);
        }
        if (get(C.STEPS).length) {
          ctx.setLineDash([1 * dpr, 1.4 * dpr]);
          ctx.lineCap = "butt";
          ctx.lineWidth = lerpW([[16, 2], [18, 3.4], [19, 5]], z) * dpr;
          strokeFeats(ctx, get(C.STEPS), ox, oy, s);
          ctx.lineCap = "round";
        }
        ctx.setLineDash([]);
      }

      // road casings then fills
      ROADS.forEach(function (r) {
        var f = get(r.c);
        if (!f.length || z < r.casZ) return;
        ctx.strokeStyle = pal[r.cas];
        ctx.lineWidth = (lerpW(r.w, z) + (z >= 15 ? 1.6 : 1.1)) * dpr;
        strokeFeats(ctx, f, ox, oy, s);
      });
      ROADS.forEach(function (r) {
        var f = get(r.c);
        if (!f.length) return;
        ctx.strokeStyle = pal[r.fill];
        ctx.lineWidth = lerpW(r.w, z) * dpr;
        strokeFeats(ctx, f, ox, oy, s);
      });

      // railways
      var rw = lerpW(RAIL_W, z) * dpr, sw = lerpW(SUB_W, z) * dpr;
      ctx.strokeStyle = pal.subway;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.lineWidth = sw;
      strokeFeats(ctx, get(C.SUBWAY + C.TUNNEL).concat(get(C.SUBWAY)), ox, oy, s);
      ctx.lineWidth = sw * 1.1;
      strokeFeats(ctx, get(C.RAIL + C.TUNNEL).concat(get(C.RAIL_JR + C.TUNNEL), get(C.LIGHT + C.TUNNEL)), ox, oy, s);
      ctx.setLineDash([]);
      ctx.strokeStyle = pal.rail;
      ctx.lineWidth = rw * 0.7;
      strokeFeats(ctx, get(C.RAIL).concat(get(C.LIGHT)), ox, oy, s);
      var jr = get(C.RAIL_JR);
      if (jr.length) {
        ctx.lineWidth = rw;
        strokeFeats(ctx, jr, ox, oy, s);
        if (z >= 11) {
          ctx.strokeStyle = pal["rail-gap"];
          ctx.lineCap = "butt";
          ctx.lineWidth = Math.max(rw - 1.8 * dpr, 0.6 * dpr);
          var d = Math.max(4, Math.min(14, rw * 2.2));
          ctx.setLineDash([d, d]);
          strokeFeats(ctx, jr, ox, oy, s);
          ctx.setLineDash([]);
          ctx.lineCap = "round";
        }
      }
    }
  });

  // label overlay ------------------------------------------------------------------------
  var FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans CJK JP","Yu Gothic UI","Yu Gothic","Meiryo",system-ui,sans-serif';

  var LabelLayer = L.Layer.extend({
    initialize: function (store, opts) {
      this.store = store;
      this.opts = opts || {};
      this.pal = readPalette();
      this.hits = [];
      this._raf = 0;
    },
    onAdd: function (map) {
      this._map = map;
      var pane = map.getPane("nbLabels") || map.createPane("nbLabels");
      pane.style.zIndex = 450;
      pane.style.pointerEvents = "none";
      this._c = L.DomUtil.create("canvas", "nb-labels", pane);
      map.on("move zoom resize viewreset", this._schedule, this);
      map.on("zoomstart", this._hide, this);
      map.on("zoomend moveend", this._show, this);
      this._redraw();
    },
    onRemove: function (map) {
      L.DomUtil.remove(this._c);
      map.off("move zoom resize viewreset", this._schedule, this);
      map.off("zoomstart", this._hide, this);
      map.off("zoomend moveend", this._show, this);
    },
    refreshPalette: function () { this.pal = readPalette(); this._redraw(); },
    _hide: function () { if (this._map && this._map._animatingZoom) this._c.style.visibility = "hidden"; },
    _show: function () { this._c.style.visibility = ""; this._schedule(); },
    _schedule: function () {
      var self = this;
      if (this._raf) return;
      this._raf = L.Util.requestAnimFrame(function () { self._raf = 0; self._redraw(); });
    },
    redraw: function () { this._schedule(); },
    _redraw: function () {
      var map = this._map;
      if (!map) return;
      var size = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      var c = this._c;
      if (c.width !== size.x * dpr || c.height !== size.y * dpr) {
        c.width = size.x * dpr; c.height = size.y * dpr;
        c.style.width = size.x + "px"; c.style.height = size.y + "px";
      }
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      var ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      var z = map.getZoom(), s = Math.pow(2, z - Z0);
      var tl = map.project(map.containerPointToLatLng([0, 0]), z);
      var minx = tl.x / s, miny = tl.y / s, maxx = (tl.x + size.x) / s, maxy = (tl.y + size.y) / s;
      var pal = this.pal, st = this.store;
      var zi = Math.floor(z + 0.001);
      var cands = st.labels.query(minx, miny, maxx, maxy, zi, []);
      var pois = z >= 15.5 ? st.pois.query(minx, miny, maxx, maxy, 99, []) : [];
      var prio = function (l) {
        if (l.t === "s") return 100 + l.r * 10;
        if (l.t === "p") return 40 + l.r * 15;
        if (l.t === "g") return 50;
        return 0;
      };
      cands.sort(function (a, b) { return prio(b) - prio(a); });
      var boxes = [];
      var free = function (x0, y0, x1, y1) {
        for (var i = 0; i < boxes.length; i++) {
          var b = boxes[i];
          if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return false;
        }
        return true;
      };
      var res = this.opts.reserved ? this.opts.reserved(tl, s) : [];
      for (var k = 0; k < res.length; k++) boxes.push(res[k]);
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      this.hits = [];

      // OSM drinking spots (unverified) as small dots
      if (pois.length) {
        var showName = z >= 17;
        ctx.font = "500 10.5px " + FONT;
        for (var p = 0; p < pois.length; p++) {
          var o = pois[p];
          var x = o.x * s - tl.x, y = o.y * s - tl.y;
          if (this.opts.skipPoi && this.opts.skipPoi(o)) continue;
          ctx.beginPath();
          ctx.arc(x, y, z >= 17 ? 3.6 : 2.6, 0, Math.PI * 2);
          ctx.fillStyle = pal.poi;
          ctx.globalAlpha = 0.85;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1;
          ctx.strokeStyle = pal["label-halo"];
          ctx.stroke();
          this.hits.push([x, y, o]);
          if (showName) {
            var w = ctx.measureText(o.n).width;
            if (free(x + 5, y - 7, x + 7 + w, y + 7)) {
              boxes.push([x + 5, y - 7, x + 7 + w, y + 7]);
              ctx.lineWidth = 3; ctx.strokeStyle = pal["label-halo"]; ctx.strokeText(o.n, x + 6, y);
              ctx.fillStyle = pal.poi; ctx.fillText(o.n, x + 6, y);
            }
          }
        }
      }

      for (var i = 0; i < cands.length; i++) {
        var l = cands[i];
        var lx = l.x * s - tl.x, ly = l.y * s - tl.y;
        if (l.t === "s") {
          var fs = l.r >= 3 ? 13.5 : l.r === 2 ? 12.5 : 11.5;
          if (z >= 15) fs += 1;
          ctx.font = "700 " + fs + "px " + FONT;
          var tw = ctx.measureText(l.n).width;
          var bw = tw + 10, bh = fs + 7;
          var bx = lx - bw / 2, by = ly - bh / 2;
          if (!free(bx - 2, by - 2, bx + bw + 2, by + bh + 2)) continue;
          boxes.push([bx - 2, by - 2, bx + bw + 2, by + bh + 2]);
          ctx.fillStyle = pal["station-box"];
          ctx.strokeStyle = pal["station-line"];
          ctx.lineWidth = 1.4;
          roundRect(ctx, bx, by, bw, bh, 3);
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = pal["label-station"];
          ctx.textAlign = "center";
          ctx.fillText(l.n, lx, ly + 0.5);
          ctx.textAlign = "left";
        } else {
          var size2, weight, color;
          if (l.t === "g") { size2 = 11; weight = 500; color = pal["label-park"]; }
          else if (l.r >= 3) { size2 = 14; weight = 700; color = pal.label; }
          else if (l.r === 2) { size2 = 12.5; weight = 700; color = pal["label-place"]; }
          else if (l.r === 1) { size2 = 11.5; weight = 500; color = pal["label-place"]; }
          else { size2 = 10.5; weight = 400; color = pal["label-place"]; }
          ctx.font = weight + " " + size2 + "px " + FONT;
          var w2 = ctx.measureText(l.n).width;
          var x0 = lx - w2 / 2, y0 = ly - size2 / 2 - 1;
          if (!free(x0 - 3, y0 - 2, x0 + w2 + 3, y0 + size2 + 4)) continue;
          boxes.push([x0 - 3, y0 - 2, x0 + w2 + 3, y0 + size2 + 4]);
          ctx.textAlign = "center";
          ctx.lineWidth = 3.2; ctx.strokeStyle = pal["label-halo"]; ctx.strokeText(l.n, lx, ly);
          ctx.fillStyle = color; ctx.fillText(l.n, lx, ly);
          ctx.textAlign = "left";
        }
      }
    },
    // nearest OSM spot within r px of a container point
    hit: function (pt, r) {
      var best = null, bd = r * r;
      for (var i = 0; i < this.hits.length; i++) {
        var h = this.hits[i], dx = h[0] - pt.x, dy = h[1] - pt.y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = h[2]; }
      }
      return best;
    }
  });

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function unproject(x, y) {
    var W = 256 * Math.pow(2, Z0);
    var lon = x / W * 360 - 180;
    var lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / W))) * 180 / Math.PI;
    return L.latLng(lat, lon);
  }

  window.NBMap = {
    Store: Store,
    VectorLayer: VectorLayer,
    LabelLayer: LabelLayer,
    dec: dec,
    unproject: unproject,
    project: function (lat, lng) {
      var W = 256 * Math.pow(2, Z0);
      var sn = Math.sin(lat * Math.PI / 180);
      return [(lng + 180) / 360 * W, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * W];
    }
  };
})();
