import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  ["presentation/society-overview.module.css", "dist/presentation/society-overview.module.css"],
  ["../../../public/brand/ustctta-badge.svg", "dist/presentation/assets/ustctta-badge.svg"],
  ["../../../public/brand/ustctta-wordmark.svg", "dist/presentation/assets/ustctta-wordmark.svg"],
  ["../../../public/society-information/hero-evening-hall.png", "dist/presentation/assets/hero-evening-hall.png"],
];

for (const [source, destination] of assets) {
  const output = path.resolve(packageRoot, destination);
  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(path.resolve(packageRoot, source), output);
}
