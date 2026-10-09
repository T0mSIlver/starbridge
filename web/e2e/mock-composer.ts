// MOCKUP only (#947): screenshots of the reply variants in /sample.
import { chromium } from "playwright";
const ORIGIN = "http://localhost:23947";
const OUT = process.argv[2];
const REPLY =
  "Not quite. Keep the API change first, but split the migration into its own PR so the checkout one stays reviewable, and before you merge anything rerun the full test suite against staging with the new routes, then show me the diff of api/orders.ts and the two failing snapshots you mentioned yesterday so I can decide whether to update them or fix the rendering.";
const b = await chromium.launch();
for (const v of ["a", "b", "c"])
  for (const scheme of ["light", "dark"] as const)
    for (const [size, vp] of [
      ["desktop", { width: 1280, height: 860 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      const phone = size === "phone";
      const p = await b.newPage({ viewport: vp, colorScheme: scheme, reducedMotion: "reduce", hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 2 : 1 });
      await p.goto(`${ORIGIN}/sample?composer=${v}`);
      await p.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      const row = p.locator(`button[data-id="d1"]`).first();
      if (size === "desktop") await row.click({ position: { x: 80, y: 12 }, force: true });
      else {
        await row.click({ position: { x: 80, y: 12 }, force: true });
        await p.getByRole("button", { name: /Back/ }).waitFor();
      }
      const field = p.getByPlaceholder("Your answer");
      await field.scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${OUT}/${v}-${size}-${scheme}-empty.png` });
      await field.fill(REPLY);
      await field.scrollIntoViewIfNeeded();
      await p.waitForTimeout(200);
      const box = await p.locator("article").last().boundingBox();
      await p.screenshot({ path: `${OUT}/${v}-${size}-${scheme}.png`, fullPage: false });
      // Close-up: from the options to the quiet row.
      const opts = p.locator("form").last();
      const ob = await opts.boundingBox();
      if (ob && box)
        await p.screenshot({
          path: `${OUT}/${v}-${size}-${scheme}-zoom.png`,
          clip: { x: box.x, y: Math.max(0, ob.y - 80), width: box.width, height: ob.height + 140 },
        });
      await p.close();
    }
await b.close();
