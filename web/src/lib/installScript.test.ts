import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicOrigin, withServer } from "./installScript";

const cli = (f: string) => readFileSync(join(import.meta.dir, "../../../cli", f), "utf8");

test("each script gets the server's origin on its server line (#749)", () => {
  const sh = withServer("install.sh", cli("install.sh"), "https://my.host");
  expect(sh).toMatch(/^SERVER='https:\/\/my\.host'$/m);
  const ps = withServer("install.ps1", cli("install.ps1"), "https://my.host");
  expect(ps).toMatch(/^ {2}\$Server = 'https:\/\/my\.host'$/m);
  expect(withServer("install.sh", cli("install.sh"), undefined)).toBe(cli("install.sh"));
});

test("only a plain http(s) origin goes into the scripts", () => {
  expect(publicOrigin({ PUBLIC_URL: "https://my.host/" })).toBe("https://my.host");
  expect(publicOrigin({ PUBLIC_URL: "http://localhost:8080" })).toBe("http://localhost:8080");
  expect(publicOrigin({ PUBLIC_URL: "https://my.host/sub'; rm -rf ~" })).toBe("https://my.host");
  expect(publicOrigin({ PUBLIC_URL: "javascript:alert(1)" })).toBeUndefined();
  expect(publicOrigin({ PUBLIC_URL: "file:///etc" })).toBeUndefined();
  expect(publicOrigin({})).toBeUndefined();
});
