// Render site/static/og.png (1200×630) and apple-touch-icon.png (180×180).
//   node promo/assets.js   (after scripts/build_site.py)
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const FILES = {
  "/promo/og.html": path.join(__dirname, "og.html"),
  "/promo/atlas.js": path.join(ROOT, "site/src/atlas.js"),
  "/promo/maplibre-gl.css": path.join(ROOT, "site/vendor/maplibre-gl.css"),
  "/icon.svg": path.join(ROOT, "site/static/icon.svg"),
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
(async () => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({ ...(proxy ? { proxy: { server: proxy } } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const route = async (ctx) => {
    await ctx.route("https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/**", (r) => r.fulfill({ body: fs.readFileSync(path.join(ROOT, "site/vendor/maplibre-gl.js")), contentType: "application/javascript" }));
    await ctx.route("http://nonbei.test/**", (r) => {
      const u = decodeURIComponent(new URL(r.request().url()).pathname);
      const f = FILES[u] || (u.startsWith("/data/") ? path.join(ROOT, "dist/site", u) : null);
      if (!f || !fs.existsSync(f)) return r.fulfill({ status: 404, body: "not found" });
      r.fulfill({ body: fs.readFileSync(f), contentType: TYPES[path.extname(f)] || "application/octet-stream" });
    });
  };
  let ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await route(ctx);
  let page = await ctx.newPage();
  await page.goto("http://nonbei.test/promo/og.html", { waitUntil: "load", timeout: 120000 });
  await page.evaluate(() => window.og);
  await page.waitForTimeout(1500);
  await page.evaluate(async () => { const m = window.nbAtlas.map; for (let i = 0; i < 400 && !(m.loaded() && m.areTilesLoaded() && !Object.values(window.nbAtlas.chunks).some((c) => c.state === "loading")); i++) await new Promise((r) => setTimeout(r, 25)); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(ROOT, "site/static/og.png") });
  await ctx.close();
  ctx = await browser.newContext({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
  await route(ctx);
  page = await ctx.newPage();
  await page.setContent('<html><body style="margin:0;background:#0b0f19"><img src="http://nonbei.test/icon.svg" width="180" height="180" style="display:block"></body></html>');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(ROOT, "site/static/apple-touch-icon.png") });
  await browser.close();
  console.log("og.png, apple-touch-icon.png written");
})();
