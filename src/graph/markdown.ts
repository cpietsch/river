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
