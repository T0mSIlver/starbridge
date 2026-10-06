// Layout checks for a page as rendered: what a screenshot shows broken, found without looking.
// run.ts runs them on every shot; each problem names the element and what is wrong with it.
import type { Page } from "playwright";

export type Problem = {
  /**
   * - `page-width`: the page is wider than the window, so a phone's browser zooms it out (#286).
   * - `clipped`: a box cuts off its own content without an ellipsis (#295).
   * - `spills`: text runs past the edge of its box.
   * - `offscreen`: something runs past the window's edge where nothing can scroll to it.
   * - `overlap`: two pieces of text are drawn over each other.
   * - `tap`: a control on a phone is smaller than 44 px across.
   * - `contrast`: text under 3:1 against what is behind it.
   */
  kind: "page-width" | "clipped" | "spills" | "offscreen" | "overlap" | "tap" | "contrast";
  what: string;
};

/** Runs in the page, so it carries everything it uses. */
function inspect(phone: boolean): Problem[] {
  const problems: Problem[] = [];
  const W = innerWidth;
  const css = (el: Element) => getComputedStyle(el);
  const name = (el: Element): string => {
    const cls = [...el.classList].map((c) => c.replace(/__[\w-]+$/, "")).join(".");
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const label = el.getAttribute("aria-label")?.slice(0, 40);
    const at = text || label ? "" : ` in ${el.parentElement ? name(el.parentElement) : "body"}`;
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${text ? ` "${text}"` : label ? ` [${label}]` : ""}${at}`;
  };
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // Also false inside a closed <details>, whose content keeps its boxes but is not drawn.
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  // Inside a box that scrolls sideways, running past an edge is the point (code blocks).
  const scrollsAcross = (el: Element) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = css(a).overflowX;
      if (o === "auto" || o === "scroll") return a !== document.documentElement;
    }
    return false;
  };
  // Bars, menus and popovers sit over the page on purpose; text under them is not covered for good.
  const layered = (el: Element) => {
    for (let a: Element | null = el; a; a = a.parentElement) {
      const { position, zIndex } = css(a);
      if (position === "fixed" || position === "sticky") return true;
      if (position === "absolute" && zIndex !== "auto") return true;
    }
    return false;
  };
  const block = (el: Element) => {
    let a: Element | null = el;
    while (a && /^(inline|contents)$/.test(css(a).display)) a = a.parentElement;
    return a;
  };

  // What of a rect its ancestors let show: a truncated name's text runs on, hidden, past its box.
  const visiblePart = (el: Element, rect: DOMRect) => {
    let { left, right, top, bottom } = rect;
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = css(a);
      const b = a.getBoundingClientRect();
      if (s.overflowX !== "visible")
        [left, right] = [Math.max(left, b.left), Math.min(right, b.right)];
      if (s.overflowY !== "visible")
        [top, bottom] = [Math.max(top, b.top), Math.min(bottom, b.bottom)];
    }
    return right - left >= 1 && bottom - top >= 1
      ? new DOMRect(left, top, right - left, bottom - top)
      : undefined;
  };
  const page = document.documentElement.scrollWidth;
  if (page > W) problems.push({ kind: "page-width", what: `the page is ${page} px wide in ${W}` });

  const all = [...document.body.querySelectorAll("*")].filter(
    (el) => !el.closest("[aria-hidden='true'], svg, script, style, noscript") && shown(el),
  );
  const drawn = new Set(all);
  for (const el of all) {
    const s = css(el);
    const hasText = (el.textContent ?? "").trim() !== "";
    if (
      hasText &&
      /hidden|clip/.test(s.overflowX) &&
      s.textOverflow !== "ellipsis" &&
      el.scrollWidth > el.clientWidth + 1
    )
      problems.push({
        kind: "clipped",
        what: `${name(el)} cuts ${el.scrollWidth - el.clientWidth} px off its width`,
      });
    if (
      hasText &&
      /hidden|clip/.test(s.overflowY) &&
      s.getPropertyValue("-webkit-line-clamp") === "none" &&
      el.scrollHeight > el.clientHeight + 1
    )
      problems.push({
        kind: "clipped",
        what: `${name(el)} cuts ${el.scrollHeight - el.clientHeight} px off its height`,
      });
    const r = el.parentElement && visiblePart(el.parentElement, el.getBoundingClientRect());
    if (r && (r.right > W + 1 || r.left < -1) && s.position !== "fixed" && !scrollsAcross(el))
      problems.push({
        kind: "offscreen",
        what: `${name(el)} spans ${Math.round(r.left)} to ${Math.round(r.right)} in ${W}`,
      });
  }

  // Every line of text, with the box it belongs in.
  const lines: { rect: DOMRect; el: Element; layered: boolean }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !(n.textContent ?? "").trim() || !drawn.has(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const box = block(el);
    const b = box?.getBoundingClientRect();
    const onTop = layered(el);
    for (const whole of range.getClientRects()) {
      const rect = visiblePart(el, whole);
      if (!rect) continue;
      lines.push({ rect, el, layered: onTop });
      if (
        box &&
        b &&
        !scrollsAcross(el) &&
        css(box).textOverflow !== "ellipsis" &&
        (rect.right > b.right + 1 || rect.left < b.left - 1)
      )
        problems.push({
          kind: "spills",
          what: `${name(el)} runs ${Math.round(Math.max(rect.right - b.right, b.left - rect.left))} px past ${name(box)}`,
        });
    }
  }
  lines.sort((p, q) => p.rect.top - q.rect.top);
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i] as (typeof lines)[number];
      const c = lines[j] as (typeof lines)[number];
      if (c.rect.top >= a.rect.bottom) break;
      if (a.el === c.el || a.layered || c.layered) continue;
      const x = Math.min(a.rect.right, c.rect.right) - Math.max(a.rect.left, c.rect.left);
      const y = Math.min(a.rect.bottom, c.rect.bottom) - Math.max(a.rect.top, c.rect.top);
      // Lines in one paragraph touch by their leading; drawn glyphs overlap by more.
      if (x > 2 && y > Math.min(a.rect.height, c.rect.height) / 2)
        problems.push({ kind: "overlap", what: `${name(a.el)} is drawn over ${name(c.el)}` });
    }

  if (phone) {
    const controls = all.filter((el) =>
      el.matches(
        "a[href], button, select, textarea, summary, input:not([type=hidden]), label:has(input), [role=button], [role=switch], [role=tab], [role=menuitem]",
      ),
    );
    for (const el of controls) {
      // A link inside a sentence is sized by its text (WCAG 2.5.8's inline exception).
      if (el.matches("a") && css(el).display === "inline") continue;
      // A control drawn inside a bigger one takes the bigger one's tap.
      if (el.parentElement?.closest("label, button, a[href], summary")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44)
        problems.push({
          kind: "tap",
          what: `${name(el)} is ${Math.round(r.width)}×${Math.round(r.height)} px`,
        });
    }
  }

  // Contrast against the first solid ground behind the text, tints laid over it. Text over an
  // image or a gradient (a blocking row's amber) is not measured.
  const rgba = (c: string) => {
    const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
    return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1] as [number, number, number, number];
  };
  const over = (top: number[], under: number[]) =>
    [0, 1, 2].map(
      (i) =>
        (top[i] as number) * (top[3] as number) + (under[i] as number) * (1 - (top[3] as number)),
    );
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const seen = new Set<Element>();
  for (const { el } of lines) {
    if (seen.has(el)) continue;
    seen.add(el);
    const tints: number[][] = [];
    let ground: number[] | undefined;
    for (let a: Element | null = el; a; a = a.parentElement) {
      const s = css(a);
      if (s.backgroundImage !== "none") break;
      const c = rgba(s.backgroundColor);
      if (c[3] === 1) {
        ground = c;
        break;
      }
      if (c[3] > 0) tints.push(c);
    }
    if (!ground && !el.closest("[style*=background], img, picture"))
      ground = rgba(css(document.body).backgroundColor);
    if (!ground) continue;
    const bg = tints.reduceRight((under, t) => over(t, under), ground);
    const s = css(el);
    const fg = over(rgba(s.color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((p, q) => q - p) as [number, number];
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < 3)
      problems.push({ kind: "contrast", what: `${name(el)} is ${ratio.toFixed(2)}:1` });
  }
  return problems;
}

export async function layoutProblems(page: Page, opts: { phone?: boolean } = {}) {
  const phone = opts.phone ?? (await page.evaluate(() => innerWidth < 600));
  const found = await page.evaluate(inspect, phone);
  // One element at fault shows up once per line of its text; keep one of each.
  return [...new Map(found.map((p) => [`${p.kind} ${p.what}`, p])).values()];
}

/**
 * Scales every element's font size and line height by `factor`, as a phone's text size setting
 * does to a page set in px. Returns a function that puts them back.
 */
export async function zoomText(page: Page, factor: number) {
  await page.evaluate((f) => {
    const sized = [...document.querySelectorAll<HTMLElement>("body, body *")].map((el) => {
      const s = getComputedStyle(el);
      return [el, Number.parseFloat(s.fontSize), Number.parseFloat(s.lineHeight)] as const;
    });
    for (const [el, size, line] of sized) {
      el.dataset.zoomed = el.getAttribute("style") ?? "";
      el.style.setProperty("font-size", `${size * f}px`, "important");
      if (line) el.style.setProperty("line-height", `${line * f}px`, "important");
    }
  }, factor);
  return () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-zoomed]")) {
        const was = el.dataset.zoomed;
        if (was) el.setAttribute("style", was);
        else el.removeAttribute("style");
        delete el.dataset.zoomed;
      }
    });
}
