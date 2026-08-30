import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  ["presentation/competition-records.module.css", "dist/presentation/competition-records.module.css"],
];

for (const [source, destination] of assets) {
  const output = path.resolve(packageRoot, destination);
  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(path.resolve(packageRoot, source), output);
}
