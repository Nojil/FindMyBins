module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // @base44/sdk builds its client as one literal mixing object spread with a
      // THROWING getter (asServiceRole). babel-preset-expo's web config applies
      // this transform with { loose: true }, which copies via Object.assign and
      // invokes that getter during client creation → crash on web only.
      // Running the spec-compliant transform first (plugins run before presets)
      // preserves accessors via property descriptors and leaves the preset's
      // loose pass nothing to transform.
      ["@babel/plugin-transform-object-rest-spread", { loose: false, useBuiltIns: false }],
    ],
  };
};
