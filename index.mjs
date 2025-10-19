// index.mjs
// ======================================================================
// BEMER proxy – Playwright + Express
// ======================================================================

import express from "express";
import { chromium } from "playwright";

// ----------------------------------------------------------------------
// 🔐 Konfiguration
// ----------------------------------------------------------------------
const TOKEN = process.env.TOKEN || "sk-superhemmelig-123";
const PORT = process.env.PORT || 10000;
const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// ----------------------------------------------------------------------
// 🧰 Hjælpere: formatering og parsing
// ----------------------------------------------------------------------
function normalizeWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function parseDKKPrice(text) {
  if (!text) return null;
  // tillad “35.100,00 kr”, “35100 kr”, “kr 35 100”, “DKK 35.100” osv.
  const m = text.match(
    /\b(?:(?:kr|dkk)\s*)?(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[.,](\d{2}))?\s*(?:kr|dkk)?\b/i
  );
  if (!m) return null;
  const intPart = m[1].replace(/[.\s]/g, "");
  const decPart = m[2] ? `.${m[2]}` : "";
  return Number(`${intPart}${decPart}`);
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean).map((s) => s.trim()))];
}

// ======================================================================
// ✨ Cookie consent: prøv flere varianter (DA/EN + populære lib’s)
// (Næste gang jeg beder dig “Udskift koden i punktet // ✨ Cookie consent…”
//  er det PRÆCIS denne blok – fra overskriften herover ned til
//  “// Cookie-banner: prøv at acceptere (flere varianter)”)
// ======================================================================
async function acceptCookiesEverywhere(page) {
  // Cookie-banner: prøv at acceptere (flere varianter)
  const tryClick = async (scope) => {
    const tries = [
      // Generiske knapper med tekst
      () => scope.getByRole("button", { name: /accepter alle|tillad alle/i }).first(),
      () => scope.getByRole("button", { name: /accept all|allow all|agree/i }).first(),
      () => scope.getByRole("button", { name: /ok|got it/i }).first(),

      // OneTrust / CookieYes / Complianz / osv. – almindelige selectors
      () => scope.locator("#onetrust-accept-btn-handler").first(),
      () => scope.locator(".ot-sdk-container .accept-btn-handler").first(),
      () => scope.locator(".cky-btn-accept").first(),
      () => scope.locator(".cmplz-accept").first(),
      () => scope.locator('button[mode="primary"]').first(),
    ];

    for (const t of tries) {
      try {
        const el = t();
        if (await el.count()) {
          const btn = el.first();
          if (await btn.isVisible()) {
            await btn.click({ timeout: 1200 });
            await page.waitForTimeout(250);
            return true;
          }
        }
      } catch {}
    }
    return false;
  };

  // 1) på hovedsiden
  if (await tryClick(page)) return;

  // 2) i iframes
  for (const f of page.frames()) {
    try {
      if (await tryClick(f)) return;
    } catch {}
  }
}
// ======================================================================
// (slut på blokken der begynder med // ✨ Cookie consent …)
// ======================================================================

// ----------------------------------------------------------------------
// 🌐 Åbn side med Playwright (inkl. cookie-accept, hydrering og lazyload)
// ----------------------------------------------------------------------
async function openPage(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    locale: "da-DK",
    extraHTTPHeaders: { "Accept-Language": "da-DK,da;q=0.9,en;q=0.8" },
  });

  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Vent til hoved-layout findes
  await page
    .waitForSelector("main, #__next, [role='main']", { timeout: 12000 })
    .catch(() => {});

  // Klik cookies – også i iframes
  await acceptCookiesEverywhere(page);

  // Lad siden blive “stille”
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);

  // Scroll igennem for at trigge lazy-load/hydrering
  await page.evaluate(async () => {
    await new Promise((r) => {
      let y = 0;
      const i = setInterval(() => {
        y += 600;
        window.scrollTo(0, y);
        if (y >= document.body.scrollHeight) {
          clearInterval(i);
          r();
        }
      }, 100);
    });
    window.scrollTo(0, 0);
  });

  // Ekstra: vent en smule på at pris dukker op i DOM (hvis muligt)
  await page
    .waitForFunction(
      () => /\b\d{1,3}(?:[.\s]\d{3})*(?:,[0-9]{2})?\s*(kr|DKK)\b/i.test(document.body.innerText),
      { timeout: 5000 }
    )
    .catch(() => {});

  return { browser, ctx, page };
}

// ----------------------------------------------------------------------
// 🧠 Udtræk: titel, pris, valuta, billeder
// ----------------------------------------------------------------------
async function scrapeProduct(page) {
  // Titel – flere faldbacks
  const title =
    normalizeWhitespace(
      await page.locator("h1, [data-test='product-title'], meta[property='og:title']").first()
        .evaluate((el) => (el.tagName === "META" ? el.content : el.textContent)).catch(() => "")
    ) ||
    (await page.title()).trim() ||
    "Bemer Shop";

  // Pris – kig først i tydelige pris-elementer
  const priceTexts = unique(
    await page
      .locator(
        [
          "[data-test*='price']",
          "[class*='price']",
          "[itemprop='price']",
          "meta[property='product:price:amount']",
        ].join(",")
      )
      .allTextContents()
  );

  // tilføj hele body-tekst som sidste fallback (kan finde “kr …”)
  priceTexts.push(await page.evaluate(() => document.body.innerText).catch(() => ""));

  let price = null;
  for (const txt of priceTexts) {
    const p = parseDKKPrice(txt);
    if (p) {
      price = p;
      break;
    }
  }

  // Valuta – forsøg at gætte, ellers DKK
  let currency = "DKK";
  const currencyHit =
    (await page
      .locator("meta[property='product:price:currency'], [itemprop='priceCurrency']")
      .first()
      .evaluate((el) => (el.tagName === "META" ? el.content : el.getAttribute("content")))
      .catch(() => null)) ||
    (/\bDKK\b/i.test(await page.evaluate(() => document.body.innerText)) ? "DKK" : null);
  if (currencyHit) currency = "DKK";

  // Billeder (små + større)
  const imgs = unique(
    await page
      .locator("img[src], meta[property='og:image']")
      .evaluateAll((els) =>
        els
          .map((el) =>
            el.tagName === "META" ? el.content : el.getAttribute("src") || el.getAttribute("data-src")
          )
          .filter(Boolean)
      )
      .catch(() => [])
  );

  return {
    ok: true,
    url: page.url(),
    title,
    description: "",
    images: imgs,
    price: price ?? null,
    currency,
    sku: "",
  };
}

// ----------------------------------------------------------------------
// 🖼  Debug-screenshot (så vi kan se hvad Playwright ser)
// ----------------------------------------------------------------------
async function screenshotPng(page) {
  const buffer = await page.screenshot({ fullPage: true, type: "png" });
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

// ----------------------------------------------------------------------
// 🚏 Express app + endpoints
// ----------------------------------------------------------------------
const app = express();

app.get("/", (_req, res) => {
  res.type("text/plain").send("BEMER proxy OK");
});

// Simpel token-check
function guard(req, res, next) {
  const t = req.query.token;
  if (!TOKEN || t === TOKEN) return next();
  return res.status(401).send("Unauthorized");
}

// HTML-render (rå HTML fra Playwright – bruges til debug/human check)
app.get("/render", guard, async (req, res) => {
  const url = req.query.url;
  const wait = Number(req.query.wait || 800);
  if (!url) return res.status(400).send("Missing url");

  try {
    const { browser, page } = await openPage(url);
    // vent en smule mere hvis ønsket
    if (wait > 0) await page.waitForTimeout(wait);

    const html = await page.content();
    res.type("text/html").send(html);

    await browser.close();
  } catch (err) {
    console.error("RENDER ERROR:", err);
    res.type("text/plain").status(500).send("Render error");
  }
});

// JSON med pris + basisfelter
app.get("/price", guard, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

  try {
    const { browser, page } = await openPage(url);
    const data = await scrapeProduct(page);
    await browser.close();

    res.json({ ok: true, price: data.price, currency: data.currency, url: data.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Fuld “product” payload
app.get("/product", guard, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

  try {
    const { browser, page } = await openPage(url);
    const data = await scrapeProduct(page);
    await browser.close();

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Debug: vis screenshot så vi kan se cookie-banner mv.
app.get("/debug", guard, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).type("text/plain").send("Missing url");

  try {
    const { browser, page } = await openPage(url);
    const data = await scrapeProduct(page);
    const img = await screenshotPng(page);
    await browser.close();

    res.type("text/html").send(`
      <html><body style="font-family:system-ui;padding:12px;">
        <h2>Debug: ${url}</h2>
        <pre>${JSON.stringify(data, null, 2)}</pre>
        <hr/>
        <img style="max-width:100%;height:auto;border:1px solid #ddd" src="${img}"/>
      </body></html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// ----------------------------------------------------------------------
// 🟢 Start server
// ----------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Proxy up on :${PORT}`);
  console.log(`Base: ${BASE}`);
});
