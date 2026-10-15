// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const path = require('path');
const os = require('os');
const { FileStore } = require('metro-cache');

const config = getDefaultConfig(__dirname);

// Use a stable on-disk store (shared across web/android)
const root = process.env.METRO_CACHE_ROOT || path.join(__dirname, '.metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(root, 'cache') }),
];

// Production optimizations
if (process.env.NODE_ENV === 'production') {
  config.transformer = {
    ...config.transformer,
    minifierConfig: {
      compress: {
        drop_console: true, // Remove console.log in production
      },
    },
  };
}

const iconsProxyPath = path.resolve(__dirname, 'src/components/icons-proxy.js');
const origResolveRequest = config.resolver?.resolveRequest;
config.resolver = {
  ...config.resolver,
  resolveRequest: (context, moduleName, platform) => {
    if (moduleName === '@expo/vector-icons') {
      return context.resolveRequest(context, iconsProxyPath, platform);
    }
    if (origResolveRequest) {
      return origResolveRequest(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

// Use available CPU parallelism so QR reloads do not rebuild serially.
config.maxWorkers = Math.max(2, os.cpus().length - 1);

module.exports = config;
