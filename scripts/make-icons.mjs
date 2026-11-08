// Generates the PWA PNG icons from public/icon.svg. Run with `npm run icons`
// and commit the output; the build does not run this script.
import sharp from 'sharp';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const source = join(publicDir, 'icon.svg');
const viewBoxSize = 512;

const targets = [
  ['pwa-192x192.png', 192],
  ['pwa-512x512.png', 512],
  ['apple-touch-icon.png', 180],
];

for (const [file, size] of targets) {
  // Rasterise the SVG at the target size (72 dpi renders the viewBox 1:1) instead of downscaling a bitmap.
  await sharp(source, { density: (72 * size) / viewBoxSize })
    .resize(size, size)
    .png()
    .toFile(join(publicDir, file));
  console.log(`wrote public/${file} (${size}x${size})`);
}
