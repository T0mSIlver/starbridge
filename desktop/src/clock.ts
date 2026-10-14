/**
 * The Mac's 12- or 24-hour choice (#1705), for the page's Time format "System". macOS keeps the
 * "24-hour time" switch (System Settings → General → Date & Time) in the global defaults as
 * AppleICUForce24HourTime, or AppleICUForce12HourTime where the region reads 24 hours; neither
 * is set while the switch sits at its region's default, which then decides.
 */
export type Hours = "12" | "24";

/** A global default as text, "" while unset: `systemPreferences.getUserDefault(key, "string")`. */
export type ReadDefault = (key: string) => string;

/**
 * `locale` is `app.getSystemLocale()`, which on a Mac with a Language & Region override reads
 * "en-US@rg=frzzzz": English, with France's formats.
 */
export function macHours(read: ReadDefault, locale: string): Hours {
  if (read("AppleICUForce24HourTime") === "1") return "24";
  if (read("AppleICUForce12HourTime") === "1") return "12";
  // The 24-hour switch set off, on a region that reads 12 hours.
  if (read("AppleICUForce24HourTime") === "0") return "12";
  return regionHours(locale);
}

/** The hours the locale's region reads, by ICU's data; the override region (`@rg=`) wins. */
export function regionHours(locale: string): Hours {
  const [tag = "", keywords = ""] = locale.split("@");
  const language = tag.split(/[-_]/)[0] ?? "";
  const region = /\brg=([a-z]{2})zzzz/i.exec(keywords)?.[1] ?? /[-_]([A-Za-z]{2})\b/.exec(tag)?.[1];
  try {
    const cycle = new Intl.DateTimeFormat(region ? `${language}-${region}` : language, {
      hour: "numeric",
    }).resolvedOptions().hourCycle;
    return cycle === "h11" || cycle === "h12" ? "12" : "24";
  } catch {
    return "24";
  }
}
