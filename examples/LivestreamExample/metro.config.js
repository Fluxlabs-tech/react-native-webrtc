const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const libraryRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// The library is linked from ../.., so Metro watches it and resolves its dependencies from its
// own node_modules, but takes React and React Native from this app only.
config.watchFolders = [libraryRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(libraryRoot, 'node_modules'),
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [
  // The repository's other examples.
  new RegExp(`^${escape(libraryRoot)}/examples/(?!LivestreamExample/).*`),
  new RegExp(`^${escape(libraryRoot)}/node_modules/(react|react-native|@types)/.*`),
];
config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, 'node_modules/react'),
  'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
};

module.exports = config;
