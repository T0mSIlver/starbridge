// The DMG keeps its background and volume icon as hidden files, which Finder shows when hidden
// files are on (#972). This places them far below the window, where they never show. dmgbuild
// takes a "position" entry, which places a file without copying one, but electron-builder's
// schema does not, so the entries join the checked configuration here, before the DMG is made.
const HIDDEN = [".background.tiff", ".VolumeIcon.icns"];

exports.default = (context) => {
  const dmg = context.packager.config.dmg;
  if (!dmg?.contents) return;
  for (const [i, path] of HIDDEN.entries())
    if (!dmg.contents.some((c) => c.path === path))
      dmg.contents.push({ x: 170 + 300 * i, y: 1200, type: "position", path });
};
