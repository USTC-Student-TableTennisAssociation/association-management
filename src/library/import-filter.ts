const LIBRARY_SYSTEM_METADATA_NAMES = new Set([
  ".ds_store",
  ".fseventsd",
  ".localized",
  ".spotlight-v100",
  ".temporaryitems",
  ".trashes",
  "$recycle.bin",
  "__macosx",
  "desktop.ini",
  "ehthumbs.db",
  "icon\r",
  "thumbs.db",
]);

function normalizedImportName(value: string): string {
  // Do not trim here: the carriage return in macOS's legacy Icon file is
  // part of its actual name.
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

/** Returns true for OS metadata, resource forks, and editor/Office lock files. */
export function isLibraryImportNoiseName(value: string): boolean {
  const name = normalizedImportName(value);
  if (LIBRARY_SYSTEM_METADATA_NAMES.has(name)) return true;
  if (name.startsWith("._")) return true;
  if (name.startsWith("~$")) return true;
  if (name.startsWith(".~lock.") && name.endsWith("#")) return true;
  return name.startsWith("~") && name.endsWith(".tmp");
}

/** A noisy directory segment makes its entire subtree ineligible for import. */
export function isLibraryImportNoisePath(relativePath: string): boolean {
  return relativePath
    .normalize("NFC")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .some(isLibraryImportNoiseName);
}
