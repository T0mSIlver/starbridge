import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  androidNotices,
  judge,
  mavenLicense,
  type Pkg,
  permissive,
  readPom,
  validateAllow,
} from "./licenses";

const pkg = (name: string, license: string): Pkg => ({ name, version: "1.0.0", license, url: "" });
const any = (license: string) => permissive(license);

test("an SPDX expression is permissive when every AND side, or one OR side, is", () => {
  expect(permissive("MIT")).toBe(true);
  expect(permissive("(MIT OR Apache-2.0)")).toBe(true);
  expect(permissive("(GPL-3.0-only OR MIT)")).toBe(true);
  expect(permissive("MIT AND LGPL-3.0-or-later")).toBe(false);
  expect(permissive("GPL-2.0-only WITH Classpath-exception-2.0")).toBe(false);
  expect(permissive("SEE LICENSE IN LICENSE.md")).toBe(false);
  expect(permissive("")).toBe(false);
});

test("Maven licence names map to SPDX ids, copyleft ones included", () => {
  expect(
    mavenLicense(
      "The Apache Software License, Version 2.0",
      "https://www.apache.org/licenses/LICENSE-2.0.txt",
    ),
  ).toBe("Apache-2.0");
  expect(mavenLicense("GNU Lesser General Public License v2.1", "")).toBe("LGPL-2.1");
  expect(mavenLicense("Mozilla Public License 2.0")).toBe("MPL");
  expect(mavenLicense("Something Bespoke")).toBe("unknown: Something Bespoke");
});

test("a new copyleft package fails, an allowed one passes, and an allowed one that changes licence fails", () => {
  const list = {
    "web-push": { license: "MPL-2.0", reason: "r" },
    "@img/sharp-libvips-*": { license: "LGPL-3.0-or-later", reason: "r" },
  };
  const ok = judge(
    [
      pkg("left-pad", "MIT"),
      pkg("web-push", "MPL-2.0"),
      pkg("@img/sharp-libvips-linuxmusl-x64", "LGPL-3.0-or-later"),
    ],
    list,
    any,
  );
  expect(ok.violations).toEqual([]);
  expect(ok.allowed.map((a) => a.pkg.name)).toEqual([
    "web-push",
    "@img/sharp-libvips-linuxmusl-x64",
  ]);

  const bad = judge(
    [pkg("gpl-thing", "GPL-3.0-only"), pkg("web-push", "AGPL-3.0-only")],
    list,
    any,
  );
  expect(bad.violations.map((v) => v.pkg.name)).toEqual(["gpl-thing", "web-push"]);
  expect(bad.unused).toEqual(["@img/sharp-libvips-*"]);
});

test("a POM without licences takes its parent's, and the notices leave versions out", () => {
  const cache = mkdtempSync(join(tmpdir(), "gradle-cache-"));
  const put = (group: string, name: string, version: string, xml: string) => {
    const dir = join(cache, group, name, version, "abc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}-${version}.pom`), xml);
  };
  put(
    "g",
    "parent",
    "1",
    "<project><licenses><license><name>MIT</name><url>https://x/mit</url></license></licenses></project>",
  );
  put(
    "g",
    "child",
    "2",
    "<project><parent><groupId>g</groupId><artifactId>parent</artifactId><version>1</version></parent><url>https://child</url></project>",
  );
  const pom = readPom(cache, "g", "child", "2");
  expect(pom.licenses).toEqual([["MIT", "https://x/mit"]]);
  expect(pom.url).toBe("https://child");
  expect(
    androidNotices([{ name: "g:child", version: "2", license: "MIT", url: "https://child" }]),
  ).not.toContain("2");
});

test("an allow-list entry without a reason is a problem, so it cannot let a package through unexplained", () => {
  const ok = { license: "MPL-2.0", reason: "r" };
  expect(validateAllow({ npm: { a: ok }, android: {} })).toEqual([]);
  expect(
    validateAllow({
      npm: { a: { ...ok, reason: " " } },
      android: { b: { license: "", reason: "r" } },
    }),
  ).toHaveLength(2);
});
