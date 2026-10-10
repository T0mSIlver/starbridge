// electron-builder's one afterPack hook, before the app is signed.
const hidden = require("./dmg-hidden.cjs").default;
const widgets = require("./widgets.cjs").default;

exports.default = async (context) => {
  hidden(context);
  await widgets(context);
};
