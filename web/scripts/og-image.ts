// Renders og-image.html to public/og.png, the 1200 by 630 link preview (lib/landing.ts).
//   bun scripts/og-image.ts      (needs `npx playwright install chromium` once)
import { join } from "node:path";
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(`file://${join(import.meta.dir, "og-image.html")}`);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(import.meta.dir, "../public/og.png") });
await browser.close();
