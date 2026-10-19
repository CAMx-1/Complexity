// Render the Alexa skill icons (108 and 512 px) from the same vector logo the
// APL screens use (lambda/src/apl/ui.js), so app icon and in-skill logo match.
// Usage: PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node scripts/render-icons.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LOGO, BG } = require('../lambda/src/apl/ui.js');
// Same paths as the APL vector logo, on the app's dark background (square, full-bleed).
const paths = LOGO.items.map((p) => `<path d="${p.pathData}" fill="${p.fill}"/>`).join('');
const svg = (px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="${BG}"/><g transform="translate(9 9) scale(0.82)">${paths}</g></svg>`;
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const px of [512, 108]) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<html><body style="margin:0">${svg(px)}</body></html>`);
  await page.screenshot({ path: `${new URL('../skill-package/assets/images/', import.meta.url).pathname}icon-${px}.png`, clip: { x: 0, y: 0, width: px, height: px } });
}
await browser.close();
console.log('ok');
