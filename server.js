const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());

app.get('/health', (req, res) => res.send('ok'));

app.get('/render', async (req, res) => {
  try {
    const { url, wait = '1500' } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing ?url=' });

    const browser = await chromium.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await (await browser.newContext()).newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const waitMs = Math.max(0, parseInt(wait, 10) || 0);
    if (waitMs) await page.waitForTimeout(waitMs);

    // tag hele body’en efter script har kørt
    const html = await page.content();

    await browser.close();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy up on ${port}`));
