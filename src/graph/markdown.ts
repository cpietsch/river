// A block of rendered content. Either a paragraph of prose (chip + emphasis
// rendered inside) or a table parsed from markdown. Tables don't carry
// chip / emphasis state in their cells today — they render as plain styled
// rows; chip phrases that overlap a table cell stay un-chipped (rare).
export type ContentBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

/**
 * Split the raw assistant text into renderable blocks. Detects markdown
 * tables (pipe-delimited with a `|---|---|` separator on the second line)
 * and breaks the rest into paragraphs by blank lines (`\n\n+`).
 */
export function parseBlocks(raw: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = raw.split('\n');
  let i = 0;
  let proseBuf: string[] = [];

  const flushProse = () => {
    if (proseBuf.length === 0) return;
    const text = proseBuf.join('\n');
    // Split prose buffer into paragraphs on blank lines.
    const paras = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    for (const p of paras) blocks.push({ kind: 'paragraph', text: p });
    proseBuf = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    // Detect a table: current line has at least two `|`s and the next
    // line is a separator row of `|---|---|...`.
    const isTableRow = (s: string) => /^\s*\|.+\|\s*$/.test(s);
    const isSeparatorRow = (s: string) => /^\s*\|[\s:-]*\|[\s:-]*(\|[\s:-]*)*\s*$/.test(s) && /-/.test(s);
    if (isTableRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      flushProse();
      const header = parseTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    proseBuf.push(line);
    i += 1;
  }
  flushProse();
  return blocks;
}

function parseTableRow(line: string): string[] {
  // Trim leading/trailing pipe and whitespace, then split on |.
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

/**
 * Tiny inline-markdown parser. Sonnet writes `**bold**`, `*italic*`, and
 * `_italic_` for emphasis. The card renderer needs to know what's plain
 * text and where the styled ranges are; the local span extractor needs to
 * see the marker-stripped plain text so spans match without `**` glued on.
 *
 * Returns:
 *   plain   — the marker-stripped text
 *   bold    — ranges (in plain-text coords) that should render bold
 *   italic  — ranges (in plain-text coords) that should render italic
 *
 * Unmatched markers are left as literal characters.
 */
export function stripMarkdown(raw: string): {
  plain: string;
  bold: { start: number; end: number }[];
  italic: { start: number; end: number }[];
} {
  let plain = '';
  const bold: { start: number; end: number }[] = [];
  const italic: { start: number; end: number }[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('**', i)) {
      const close = raw.indexOf('**', i + 2);
      if (close === -1) {
        plain += '**';
        i += 2;
        continue;
      }
      const start = plain.length;
      plain += raw.slice(i + 2, close);
      bold.push({ start, end: plain.length });
      i = close + 2;
      continue;
    }
    const ch = raw[i];
    if ((ch === '*' || ch === '_') && raw[i + 1] !== ch) {
      const close = raw.indexOf(ch, i + 1);
      if (close === -1 || raw[close + 1] === ch) {
        plain += ch;
        i++;
        continue;
      }
      const start = plain.length;
      plain += raw.slice(i + 1, close);
      italic.push({ start, end: plain.length });
      i = close + 1;
      continue;
    }
    plain += ch;
    i++;
  }
  return { plain, bold, italic };
}
