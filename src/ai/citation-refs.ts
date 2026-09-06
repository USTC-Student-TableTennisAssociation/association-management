const REF_TOKEN_SOURCE = "(?:A|F|H|S|V)\\d+";
const REF_SEPARATOR_SOURCE = "[\\s,，、/／;；]+";
const REF_GROUP_SOURCE = `${REF_TOKEN_SOURCE}(?:${REF_SEPARATOR_SOURCE}${REF_TOKEN_SOURCE})*`;
const WRAPPED_REF_GROUP = new RegExp(
  `\\[\\s*(${REF_GROUP_SOURCE})\\s*\\]` +
    `|【\\s*(${REF_GROUP_SOURCE})\\s*】` +
    `|\\(\\s*(${REF_GROUP_SOURCE})\\s*\\)` +
    `|（\\s*(${REF_GROUP_SOURCE})\\s*）`,
  "g",
);
const REF_TOKEN = new RegExp(REF_TOKEN_SOURCE, "g");

/**
 * Read request-local references from the citation shapes models naturally use.
 * Bare tokens remain invalid so prose such as a filename containing "S1" is not
 * accidentally treated as evidence.
 */
export function allCitedRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(WRAPPED_REF_GROUP)) {
    const group = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    refs.push(...(group.match(REF_TOKEN) ?? []));
  }
  return refs.filter((ref, index) => refs.indexOf(ref) === index);
}

export function citedRefs(
  text: string,
  prefix: "A" | "F" | "H" | "S" | "V",
): string[] {
  return allCitedRefs(text).filter((ref) => ref.startsWith(prefix));
}
