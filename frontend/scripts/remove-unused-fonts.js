#!/usr/bin/env node
/**
 * Post-build script to remove unused icon font files from the dist folder.
 * Only keeps Ionicons.ttf (the sole font family used in the app).
 * This reduces the deployed bundle by ~4.1 MB.
 * 
 * Usage: Run automatically after `expo export -p web` via npm postbuild script
 */

const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const FONTS_TO_REMOVE = [
  'AntDesign.ttf',
  'Entypo.ttf',
  'EvilIcons.ttf',
  'Feather.ttf',
  'FontAwesome.ttf',
  'FontAwesome5_Brands.ttf',
  'FontAwesome5_Regular.ttf',
  'FontAwesome5_Solid.ttf',
  'FontAwesome6_Brands.ttf',
  'FontAwesome6_Regular.ttf',
  'FontAwesome6_Solid.ttf',
  'Fontisto.ttf',
  'Foundation.ttf',
  // 'Ionicons.ttf', ← Keep this one
  'MaterialCommunityIcons.ttf',
  'MaterialIcons.ttf',
  'Octicons.ttf',
  'SimpleLineIcons.ttf',
  'Zocial.ttf',
];

function findAndRemoveFonts(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const files = fs.readdirSync(dir);
  let removedCount = 0;
  let savedBytes = 0;

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const result = findAndRemoveFonts(fullPath);
      removedCount += result.count;
      savedBytes += result.bytes;
    } else if (stat.isFile()) {
      const baseName = path.basename(file);
      
      // Check if this file matches any font to remove (handles hashed names like AntDesign.abc123def.ttf)
      const shouldRemove = FONTS_TO_REMOVE.some(fontName => {
        const nameWithoutExt = fontName.replace('.ttf', '');
        return baseName.startsWith(nameWithoutExt) && baseName.endsWith('.ttf');
      });

      if (shouldRemove) {
        const fileSize = stat.size;
        fs.unlinkSync(fullPath);
        console.log(`  ✓ Removed ${baseName} (${(fileSize / 1024).toFixed(1)} KB)`);
        removedCount++;
        savedBytes += fileSize;
      }
    }
  }

  return { count: removedCount, bytes: savedBytes };
}

console.log('\n🔧 Removing unused icon fonts from build...\n');

const result = findAndRemoveFonts(DIST_DIR);

if (result.count > 0) {
  console.log(`\n✅ Removed ${result.count} unused font files`);
  console.log(`💾 Saved ${(result.bytes / 1024 / 1024).toFixed(2)} MB\n`);
} else {
  console.log('\n✅ No unused fonts found (already optimized)\n');
}
