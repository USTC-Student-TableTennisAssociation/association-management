export function citedRefs(
  text: string,
  prefix: "A" | "F" | "H" | "S" | "V",
): string[] {
  const pattern = new RegExp(`(?:\\[(${prefix}\\d+)\\]|【(${prefix}\\d+)】)`, "g");
  return [...text.matchAll(pattern)]
    .map((match) => match[1] ?? match[2])
    .filter((ref, index, refs): ref is string => Boolean(ref) && refs.indexOf(ref) === index);
}

export function allCitedRefs(text: string): string[] {
  const pattern = /(?:\[((?:A|F|H|S|V)\d+)\]|【((?:A|F|H|S|V)\d+)】)/g;
  return [...text.matchAll(pattern)]
    .map((match) => match[1] ?? match[2])
    .filter((ref, index, refs): ref is string => Boolean(ref) && refs.indexOf(ref) === index);
}
