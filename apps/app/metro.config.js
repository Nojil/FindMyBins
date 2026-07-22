// Metro config for an npm-workspaces monorepo.
//
// One-shot bundling resolves the workspace packages without this, but the dev
// server only watches the project folder by default — so edits to
// packages/core or packages/api-client would not hot-reload. Watching the
// workspace root and listing both node_modules directories fixes that.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
