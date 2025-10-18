import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 10000;

// Healthcheck
app.get("/", (_req, res) => {
  res.send("BEMER proxy OK");
});

// Hovedruten til at rendre en side
app.get("/render", async (req, res) => {
  const { url, wait = "1500", token } = req.query;

  if (!url) return res.status(400).send("Missing 'url' param");

  // Simpel token-beskyttelse
  if (process.env.TOKEN && token !== process.env.TOKEN) {
    return res.status(403).send("Forbidden: bad token");
  }

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    });

    const page = await context.newPage();
    const target = decodeURIComponent(url);

    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(Number(wait));

    const html = await page.content();

    await browser.close();

    res.set("Cache-Control", "no-store");
    res.status(200).send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Render error");
  }
});

app.listen(PORT, () => {
  console.log(`Proxy up on :${PORT}`);
});
