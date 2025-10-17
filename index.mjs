import express from "express";
import { chromium } from "playwright";

const TOKEN = process.env.TOKEN || "change-me";
const PORT  = process.env.PORT || 3010;

const app = express();

function normalizeDKPrice(s) {
  if (!s) return null;
  s = ("" + s).replace(/\u00A0|&nbsp;|\s+|kr\.?|DKK/gi, "");
  s = s.replace(/\./g, "").replace(",", ".");
  const v = parseFloat(s);
  return isFinite(v) ? Math.round(v) : null;
}

async function scrapPriceForSku(browser, sku) {
  const prodUrl = `https://shop.bemergroup.com/da_DK/horseset_line/${sku}`;
  const catUrl  = `https://shop.bemergroup.com/da_DK/horseset_line`;

  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "da-DK",
  });

  const page = await ctx.newPage();
  const gotoOpts = { waitUntil: "domcontentloaded", timeout: 30000 };

  // 1) Produkt-siden
  await page.goto(prodUrl, gotoOpts);

  // a) “Vejledende pris” blok (det var dét som virkede hos dig)
  try {
    const priceText = await page.locator("text=/Vejledende pris|Vejledende/i")
      .locator("xpath=following::*[1]")
      .first()
      .innerText({ timeout: 4000 })
      .catch(() => null);

    if (priceText) {
      const p = normalizeDKPrice(priceText);
      if (p) return { ok: true, price: p, detector: "vejledende-block", url: prodUrl, via: "product" };
    }
  } catch (_) {}

  // b) Fald tilbage: find alle “xx.xxx,yy kr” i hele HTML
  const html1 = await page.content();
  const m1 = [...html1.matchAll(/([0-9]{1,3}(?:\.[0-9]{3})*,\d{2})\s*(?:kr|DKK)/gi)].map(x => x[1]);
  if (m1.length) {
    const nums = m1.map(normalizeDKPrice).filter(Boolean);
    if (nums.length) {
      const best = Math.max(...nums);
      return { ok: true, price: best, detector: "regex-product", url: prodUrl, via: "product" };
    }
  }

  // 2) Kategori-siden som fallback
  await page.goto(catUrl, gotoOpts);

  // find et udsnit omkring sku og tag nærmeste “kr”-pris
  const html2 = await page.content();
  const pos = html2.indexOf(`/horseset_line/${sku}`);
  if (pos !== -1) {
    const start = Math.max(0, pos - 2000);
    const slice = html2.slice(start, pos + 2000);
    const m2 = [...slice.matchAll(/([0-9]{1,3}(?:\.[0-9]{3})*,\d{2})\s*(?:kr|DKK)/gi)].map(x => x[1]);
    if (m2.length) {
      const nums = m2.map(normalizeDKPrice).filter(Boolean);
      if (nums.length) {
        const best = Math.max(...nums);
        return { ok: true, price: best, detector: "regex-category", url: catUrl, via: "category" };
      }
    }
  }

  // Ikke fundet
  return { ok: false, error: "price_not_found", urlTried: [prodUrl, catUrl] };
}

app.get("/price", async (req, res) => {
  try {
    const { sku, token } = req.query;
    if (!token || token !== TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    if (!sku || !/^\d{5,}$/.test(sku)) {
      return res.status(400).json({ ok: false, error: "bad_sku" });
    }

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const out = await scrapPriceForSku(browser, String(sku));
      return res.json({ sku: String(sku), ...out });
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "proxy_error" });
  }
});

app.get("/", (_, res) => res.send("BEMER proxy OK"));
app.listen(PORT, () => console.log(`Proxy up on :${PORT}`));


const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});


