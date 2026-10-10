// babel-preset-expo compiles object spread for engines other than Hermes, which
// means the browser bundle, with `{ loose: true }`: `{ ...base, get value() {} }`
// becomes `Object.assign({}, base, { get value() {} })`, which reads each getter
// once and copies the result. Effect builds every Exit that way, so in the
// browser `exit.value` and `exit.cause` are always undefined and every
// Schema.Class constructor throws. The spec transform keeps getters as getters.
// Plugins listed here run before the preset's, so the loose copy finds no spread
// left. Native (Hermes) and the static render (Node) keep native spread and are
// untouched.
module.exports = function (api) {
  const platform = api.caller((caller) => caller?.platform);
  const engine = api.caller((caller) => caller?.engine);
  const browser = platform === "web" && engine !== "hermes";
  return {
    presets: ["babel-preset-expo"],
    plugins: browser ? ["@babel/plugin-transform-object-rest-spread"] : [],
  };
};
