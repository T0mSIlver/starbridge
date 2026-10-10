// Puts the Needs you widget in the app (#1031): builds widgets/ once, copies the extension into
// Contents/PlugIns and its helper beside the executable, and signs both with their own
// entitlements and the app's identity. electron-builder signs neither: it skips Contents/PlugIns,
// and `mac.signIgnore` keeps it off the helper, whose App Group entitlement the Electron helpers'
// entitlements would replace. The app's own signature, made after this, seals both.
const { execFileSync } = require("node:child_process");
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const GROUP = readFileSync(join(ROOT, "src/widgets.ts"), "utf8").match(/APP_GROUP = "(.+?)"/)[1];

/** Both architectures' packs share one build. */
let built = false;

function plist(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${entries}
<key>com.apple.security.application-groups</key><array><string>${GROUP}</string></array>
</dict></plist>
`;
}

/**
 * The identity electron-builder signs the app with, and the keychain it imported it into: "-" ad
 * hoc, a Developer ID's hash, or null for an unsigned build.
 */
async function identity(packager) {
  const configured = packager.platformSpecificBuildOptions.identity;
  if (configured === "-" || configured === null) return { id: configured, keychain: null };
  const { keychainFile } = await packager.codeSigningInfo.value;
  const args = [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    ...(keychainFile ? [keychainFile] : []),
  ];
  const found = execFileSync("security", args, { encoding: "utf8" })
    .split("\n")
    .find(
      (l) => l.includes('"Developer ID Application:') && (!configured || l.includes(configured)),
    );
  return { id: found ? found.trim().split(/\s+/)[1] : null, keychain: keychainFile };
}

exports.default = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
  );
  if (!built) {
    // The extension carries the app's id and versions, as Electron's own helpers do.
    const info = (key) =>
      execFileSync("plutil", ["-extract", key, "raw", join(app, "Info.plist")], {
        encoding: "utf8",
      }).trim();
    const keys = ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"];
    execFileSync(join(ROOT, "widgets/build.sh"), [...keys.map(info), GROUP], { stdio: "inherit" });
    built = true;
  }
  const appex = join(app, "PlugIns/StarbridgeWidgets.appex");
  const helper = join(app, "MacOS/starbridge-widgets");
  rmSync(appex, { recursive: true, force: true });
  cpSync(join(ROOT, "widgets/build/StarbridgeWidgets.appex"), appex, { recursive: true });
  cpSync(join(ROOT, "widgets/build/starbridge-widgets"), helper);

  const { id, keychain } = await identity(context.packager);
  if (id === null) return;
  const dir = mkdtempSync(join(tmpdir(), "starbridge-widgets-"));
  try {
    const sandboxed = join(dir, "widget.plist");
    const grouped = join(dir, "helper.plist");
    // An app extension on macOS must be sandboxed; the widget reads one file and opens nothing.
    writeFileSync(sandboxed, plist("<key>com.apple.security.app-sandbox</key><true/>"));
    writeFileSync(grouped, plist(""));
    const hardened = context.packager.platformSpecificBuildOptions.hardenedRuntime !== false;
    const flags = ["--force", "--sign", id, ...(hardened ? ["--options", "runtime"] : [])];
    if (id !== "-") flags.push("--timestamp");
    if (keychain) flags.push("--keychain", keychain);
    execFileSync("codesign", [...flags, "--entitlements", grouped, helper], { stdio: "inherit" });
    execFileSync("codesign", [...flags, "--entitlements", sandboxed, appex], { stdio: "inherit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
