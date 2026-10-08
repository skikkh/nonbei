// Render promo/reel.html frame by frame with headless Chromium.
//   node promo/capture.js frames [from] [to]   → promo/out/frames/f0000.jpg … (skips frames already on disk)
//   node promo/capture.js stills 2,6.5,11      → promo/out/still-<t>.png
// Needs `npm run build` first (the reel reads dist/site/data). PW=path/to/playwright if not on the module path.
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "out");
const FILES = {
  "/promo/reel.html": path.join(__dirname, "reel.html"),
  "/promo/reel.js": path.join(__dirname, "reel.js"),
  "/promo/atlas.js": path.join(ROOT, "site/src/atlas.js"),
  "/promo/maplibre-gl.css": path.join(ROOT, "site/vendor/maplibre-gl.css"),
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

(async () => {
  const [mode, a, b] = process.argv.slice(2);
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    ...(proxy ? { proxy: { server: proxy } } : {}),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const ctx = await browser.newContext({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
  await ctx.route("https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/**", (r) =>
    r.fulfill({ body: fs.readFileSync(path.join(ROOT, "site/vendor/maplibre-gl.js")), contentType: "application/javascript" }));
  await ctx.route("http://nonbei.test/**", (r) => {
    const u = decodeURIComponent(new URL(r.request().url()).pathname);
    const f = FILES[u] || (u.startsWith("/data/") ? path.join(ROOT, "dist/site", u) : null);
    if (!f || !fs.existsSync(f)) return r.fulfill({ status: 404, body: "not found" });
    r.fulfill({ body: fs.readFileSync(f), contentType: TYPES[path.extname(f)] || "application/octet-stream" });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto("http://nonbei.test/promo/reel.html", { waitUntil: "load", timeout: 120000 });
  await page.evaluate(() => window.reel.ready());
  const shot = async (t, file, type) => {
    await page.evaluate((t) => window.reel.seek(t), t);
    await page.evaluate(() => window.reel.settled());
    await page.screenshot({ path: file, type, ...(type === "jpeg" ? { quality: 93 } : {}) });
  };
  // warm the caches so the first frames do not wait on cold chunks
  for (const t of [0, 10, 14, 19, 23]) { await page.evaluate((t) => window.reel.seek(t), t); await page.evaluate(() => window.reel.settled()); }
  if (mode === "stills") {
    for (const t of (a || "2").split(",").map(Number)) {
      await shot(t, path.join(OUT, `still-${t}.png`), "png");
      console.log("still", t);
    }
  } else {
    const fps = 30, n = 30 * fps;
    const from = +(a || 0), to = Math.min(n, +(b || n));
    const t0 = Date.now();
    for (let f = from; f < to; f++) {
      const file = path.join(OUT, "frames", `f${String(f).padStart(4, "0")}.jpg`);
      if (fs.existsSync(file)) continue;
      await shot(f / fps, file, "jpeg");
      if (f % 30 === 0) console.log(`frame ${f} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }
  await browser.close();
})();
