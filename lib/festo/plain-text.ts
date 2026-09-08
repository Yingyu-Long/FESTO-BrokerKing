import { compile } from "html-to-text";

const convert = compile({
  wordwrap: false,
  preserveNewlines: true,
  limits: { maxInputLength: undefined },
  selectors: [
    { selector: ".ql-ui", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "img", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
    ...["ol", "ul", "li"].map((selector) => ({
      selector,
      format: "block",
      options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
    })),
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
      selector,
      options: { uppercase: false },
    })),
  ],
});

/** Convert API rich text once, before sharing rows with the preview and CSV. */
export function plainText(value: string | null | undefined): string {
  if (!value) return "";
  // Preserve ordinary text, including newlines and comparisons such as x < 5.
  if (!/<\/?[a-z][\w:-]*(?:\s[^<>]*|\s*\/?)>/i.test(value) &&
      !/&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(value)) return value;
  return convert(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
