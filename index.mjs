// index.mjs
import express from "express";
import { chromium, devices } from "playwright";

const app = express();
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TOKEN || "sk-superhemmelig-123";

// --- fælles Playwright launcher ---
async function openPage(url) {
  // Brug et “rigtigt” desktop device + dansk sprog
  const iPhone = devices["Desktop Chrome"];
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const ctx = await browser.newContext({
    ...iPhone,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    locale: "da-DK",
    extraHTTPHeaders: {
      "Accept-Language": "da-DK,da;q=0.9,en;q=0.8"
    }
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Cookie-banner: prøv at acceptere (flere varianter)
  try {
    // generisk knap med tekst
    const btn = page.getByRole("button", { name: /accepter alle|accept all/i });
    if (await btn.isVisible({ timeout: 3000 })) await btn.click();
  } catch (_) {}
  try {
    // CookieYes / OneTrust typiske id’er/klasser
    await page
      .locator(
        [
          "#cky-btn-accept",
          "#onetrust-accept-btn-handler",
          ".cky-btn-accept",
          "button[aria-label='Accept all']",
          "button[mode='primary']"
        ].join(",")
      )
      .first()
      .click({ timeout: 2000 });
  } catch (_) {}

  // Vent lidt på at indholdet/SPA’en har hydrateret
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);

// ... i openPage(url) lige før return:
try {
  // Vent på at hovedindhold er på plads (tilpas selectors hvis nødvendigt)
  await page.waitForSelector("main, #__next, [role='main']", { timeout: 12000 });
} catch (_) {}
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(800); // lidt ekstra ro efter hydrer
return { browser, ctx, page };

  }

// --- auth middleware ---
function requireToken(req, res, next) {
  if (!TOKEN) return res.status(500).send("Server token not set");
  if (req.query.token !== TOKEN) return res.status(401).send("Invalid token");
  next();
}

// ping
app.get("/", (_req, res) => res.send("BEMER proxy OK"));

// rå HTML
app.get("/render", requireToken, async (req, res) => {
  const url = req.query.url;
  const wait = Number(req.query.wait || 0);
  if (!url) return res.status(400).send("Missing url");
  let browser, ctx, page;
  try {
    ({ browser, ctx, page } = await openPage(url));
    if (wait > 0) await page.waitForTimeout(wait);
    const html = await page.content();
    res.type("text/html").send(html);
  } catch (err) {
    res.status(500).send("Render error");
  } finally {
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
});

async function scrapeProduct(page) {
  return await page.evaluate(() => {
    const out = {
      title: "",
      description: "",
      images: [],
      price: null,
      currency: "",
      sku: ""
    };

    // helper’e
    const text = (el) => (el ? (el.textContent || "").trim() : "");
    const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || "";

    // 1) JSON-LD Product (som før)
    const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of ldScripts) {
      try {
        const data = JSON.parse(s.textContent || "null");
        const arr = Array.isArray(data) ? data : [data];
        for (const node of arr) {
          if (!node || typeof node !== "object") continue;
          if (node["@type"] === "Product") {
            out.title ||= node.name || "";
            out.description ||= node.description || "";
            const imgs = node.image ? (Array.isArray(node.image) ? node.image : [node.image]) : [];
            out.images.push(...imgs);
            const offers = node.offers ? (Array.isArray(node.offers) ? node.offers : [node.offers]) : [];
            if (offers[0]) {
              const o = offers[0];
              out.price = Number(o.price || o.priceSpecification?.price) || out.price;
              out.currency = (o.priceCurrency || o.priceSpecification?.priceCurrency || out.currency || "");
            }
            out.sku ||= node.sku || "";
          }
        }
      } catch {}
    }

    // 2) Titel & meta fallback
    out.title ||= text(document.querySelector("h1")) ||
                  attr("meta[property='og:title']", "content") ||
                  document.title || "";

    // 3) Beskrivelse: prøv produktsektioner og meta
    const descCandidates = [
      "[data-testid*='description']",
      "[class*='description']",
      "[itemprop='description']",
      "section[aria-label*='beskrivelse' i]"
    ];
    for (const sel of descCandidates) {
      const el = document.querySelector(sel);
      if (el) { out.description = text(el); if (out.description) break; }
    }
    out.description ||= attr("meta[name='description']", "content") || "";

    // 4) Pris & valuta fallback
    if (out.price == null) {
      const priceNode =
        document.querySelector("[itemprop='price']") ||
        document.querySelector("[data-testid*='price']") ||
        document.querySelector("[class*='price']");
      const txt = text(priceNode);
      const m = txt.match(/(\d{1,3}([.\s]\d{3})*|\d+)([,\.\s]\d{2})?/);
      if (m) {
        const norm = m[0].replace(/\./g, "").replace(/\s/g, "").replace(",", ".");
        const num = Number(norm);
        if (!Number.isNaN(num)) out.price = num;
      }
      if (!out.currency) {
        if (/[€]/.test(txt)) out.currency = "EUR";
        else if (/(kr|DKK)/i.test(txt)) out.currency = "DKK";
      }
    }

    // 5) Billeder – flere kilder
    const addImg = (u) => { if (u && typeof u === "string") out.images.push(u); };

    // a) OG image
    addImg(attr("meta[property='og:image']", "content"));

    // b) Preload’d images
    document.querySelectorAll("link[rel='preload'][as='image'][href]").forEach(l => addImg(l.getAttribute("href")));

    // c) Synlige <img>
    document.querySelectorAll("img").forEach(img => {
      addImg(img.currentSrc || img.src || "");
      const srcset = img.getAttribute("srcset");
      if (srcset) {
        const last = srcset.split(",").map(s => s.trim().split(" ")[0]).pop();
        addImg(last);
      }
    });

    // d) background-image på elementer
    document.querySelectorAll("*").forEach(el => {
      const bg = getComputedStyle(el).getPropertyValue("background-image");
      const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m && m[1]) addImg(m[1]);
    });

    // e) Ryd op & gør unik
    out.images = Array.from(new Set(out.images.filter(Boolean)));

    // 6) SKU – kig efter itemprop eller data-attributter
    out.sku ||= attr("[itemprop='sku']", "content") || text(document.querySelector("[itemprop='sku']")) || "";

    return out;
  });
}


// JSON: fuldt produkt
app.get("/product", requireToken, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });
  let browser, ctx, page;
  try {
    ({ browser, ctx, page } = await openPage(url));
    const data = await scrapeProduct(page);
    res.json({ ok: true, url, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  } finally {
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
});

// JSON: kun pris
app.get("/price", requireToken, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });
  let browser, ctx, page;
  try {
    ({ browser, ctx, page } = await openPage(url));
    const { price, currency } = await scrapeProduct(page);
    res.json({ ok: true, url, price, currency });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  } finally {
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Proxy up on :${PORT}`);
});

app.get("/debug", requireToken, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing url");
  let browser, ctx, page;
  try {
    ({ browser, ctx, page } = await openPage(url));
    await page.waitForTimeout(Number(req.query.wait || 800));
    const buf = await page.screenshot({ fullPage: true, type: "png" });
    res.type("image/png").send(buf);
  } catch (e) {
    res.status(500).send("debug error: " + (e?.message || e));
  } finally {
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
});


