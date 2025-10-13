import express from "express";
import puppeteer from "puppeteer";

const app = express();

// GET /render?url=ENCODET_URL&wait=1500
app.get("/render", async (req, res) => {
  const target = req.query.url;
  const wait = Number(req.query.wait || 1500);

  if (!target) {
    return res.status(400).send("Missing ?url=…");
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      headless: true
    });
    const page = await browser.newPage();
    await page.goto(target, { waitUntil: "networkidle2", timeout: 60000 });
    if (wait > 0) await page.waitForTimeout(wait);

    const html = await page.content();
    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send("Render error");
  } finally {
    if (browser) await browser.close();
  }
});

app.get("/", (_req, res) => res.send("OK"));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Render proxy listening on " + port));
