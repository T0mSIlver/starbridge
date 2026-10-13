// electron-builder's afterSign hook: notarizes and staples the signed app when the release
// workflow passes the App Store Connect key (scripts/sign.sh). @electron/notarize does both too,
// but its staple retries 3 times within seconds, and Apple's ticket lookup drops the connection
// for longer than that now and then (#1512). Here only the staple is retried, 30 s apart; a
// notarization that is rejected, or a staple that fails every time, fails the build.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const sleep = (s) => execFileSync("sleep", [String(s)]);

exports.default = async (context) => {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (context.electronPlatformName !== "darwin" || !APPLE_API_KEY_ID) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const zip = `${app}.zip`;
  run("ditto", ["-c", "-k", "--keepParent", app, zip]);
  // --wait exits non-zero unless the status is Accepted.
  run("xcrun", ["notarytool", "submit", zip, "--wait",
    "--key", APPLE_API_KEY, "--key-id", APPLE_API_KEY_ID, "--issuer", APPLE_API_ISSUER]);
  for (let attempt = 1; ; attempt++) {
    try {
      run("xcrun", ["stapler", "staple", "-v", app]);
      break;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`staple failed (try ${attempt} of 3), retrying in 30 s`);
      sleep(30);
    }
  }
  run("rm", ["-f", zip]);
};
