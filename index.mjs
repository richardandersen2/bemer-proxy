import express from 'express';

// Tving Playwright til at bruge browsers placeret i node_modules
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

// Importér først Playwright EFTER env-variablen er sat
const { chromium } = await import('playwright');

const app = express();
const PORT = process.env.PORT || 10000;

// simple health endpoints
app.get("/", (_req, res) => res.send("BEMER proxy OK"));
app.get("/healthz", (_req, res) => res.send("ok"));

// GET /render?token=...&url=ENCODED_URL&wait=1500&selector=.css-selector
app.get("/render", async (req, res) => {
  const { token, url, wait, selector } = req.query;

  try {
    // 1) token og param-tjek
    if (!token || token !== process.env.TOKEN) {
      return res.status(401).send("Unauthorized");
    }
    if (!url) {
      return res.status(400).send("Missing url parameter");
    }

    // 2) normalisér inputs
    const target = decodeURIComponent(String(url));
    const waitMs = Number(wait ?? 1500);
    if (Number.isNaN(waitMs) || waitMs < 0) {
      return res.status(400).send("Invalid wait parameter");
    }

    // 3) start Playwright
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });

    // skip tunge assets (hurtigere og færre blokeringer)
    await context.route("**/*", (route) => {
      const rt = route.request().resourceType();
      if (["image", "font", "media"].includes(rt)) route.abort();
      else route.continue();
    });

    const page = await context.newPage();

    // 4) hent siden
    await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // 5) vent – enten på selector eller bare et delay
    if (selector) {
      await page.waitForSelector(String(selector), { timeout: waitMs });
    } else {
      await page.waitForTimeout(waitMs);
    }

    // 6) returnér HTML
    const html = await page.content();
    await browser.close();

    res.set("content-type", "text/html; charset=utf-8").send(html);
  } catch (err) {
    // log ALT til Render-logs og giv fejlen videre i svaret
    console.error("RENDER ERROR:", err);
    const msg =
      (err && err.message) ? err.message : String(err ?? "Unknown error");
    res.status(500).send("Render error: " + msg);
  }
});

// start server
app.listen(PORT, () => {
  console.log(`Proxy up on :${PORT}`);
});


