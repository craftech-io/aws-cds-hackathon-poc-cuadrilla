// A code in words for a screen: the copy's label, or the code made readable (never with its underscores).
export function codeLabel(labels: Readonly<Record<string, string>>, code: string): string {
  const known = labels[code];
  if (known !== undefined) return known;
  const words = code.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
