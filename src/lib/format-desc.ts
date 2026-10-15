/**
 * Supplier descriptions often pack every point into a single line, separated
 * only by checkmarks / bullets ("✔ A ✔ B ✔ C"). This turns each marker into
 * its own line so the description reads line by line in the bot and website.
 */
export function formatDescription(raw: string): string {
  const text = String(raw || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    // VS16 (U+FE0F) on a line-starting emoji makes some Telegram clients float
    // the glyph onto the previous line; drop it so the emoji stays inline.
    .replace(/(^|\n)([ \t]*)(\p{Extended_Pictographic})\uFE0F/gu, "$1$2$3");
  return text
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [""];
      return line.split(/\s*(?=[✔✔️✅☑✓•●▪◆★])/).map((part) => part.trim());
    })
    .join("\n");
}

/**
 * A section heading is a short line ending in ":" or ":-" that does not itself
 * start with an emoji/bullet (those are content lines). Headings render as
 * plain text; the lines under them render inside their own blockquote — the
 * "quoted sections" layout.
 */
function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  if (!/[:：]-?$/.test(t)) return false;
  // A line that leads with an emoji/bullet is content, not a heading.
  if (/^(\p{Extended_Pictographic}|[✔✅☑✓•●▪◆★])/u.test(t)) return false;
  return true;
}

export type DescSection = { heading: string; body: string };

/**
 * Split a formatted description into { heading, body } sections. Lines before
 * the first heading (and descriptions with no headings) are returned as a
 * single section with an empty heading, so callers can fall back to one quote.
 */
export function splitDescriptionSections(raw: string): DescSection[] {
  const lines = formatDescription(raw).split("\n");
  const sections: DescSection[] = [];
  let heading = "";
  let body: string[] = [];
  const flush = () => {
    const text = body.join("\n").replace(/^\n+|\n+$/g, "");
    if (heading || text) sections.push({ heading, body: text });
    heading = "";
    body = [];
  };
  for (const line of lines) {
    if (isHeading(line)) {
      flush();
      heading = line.trim();
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}
