import nlp from 'compromise';
import type { ChipSpan } from '../api';

// Single-word stopwords we never want to surface as chips even when they
// happen to be capitalized (sentence-start "The", "Most", connectives like
// "However", pronouns, etc.). Lowercased.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its',
  'he', 'she', 'we', 'you', 'they', 'i', 'my', 'our', 'your', 'their',
  'his', 'her', 'will', 'would', 'can', 'could', 'should', 'may',
  'might', 'must', 'has', 'have', 'had', 'do', 'does', 'did', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'when', 'where', 'why',
  'how', 'what', 'which', 'who', 'whose', 'if', 'then', 'than', 'but',
  'and', 'or', 'so', 'yet', 'for', 'with', 'about', 'into', 'onto',
  'from', 'in', 'on', 'at', 'by', 'of', 'to', 'as', 'also', 'just',
  'only', 'even', 'still', 'however', 'therefore', 'thus', 'hence',
  'otherwise', 'meanwhile', 'furthermore', 'moreover', 'besides',
  'additionally', 'similarly', 'likewise', 'conversely', 'consequently',
  'accordingly', 'naturally', 'obviously', 'perhaps', 'maybe',
  'possibly', 'probably', 'certainly', 'definitely', 'absolutely',
  'exactly', 'essentially', 'basically', 'generally', 'typically',
  'usually', 'often', 'sometimes', 'rarely', 'never', 'always',
  'indeed', 'simply', 'really', 'very', 'much', 'more', 'most',
  'less', 'least', 'many', 'few', 'several', 'some', 'any', 'all',
  'each', 'every', 'both', 'either', 'neither', 'not', 'no',
]);

/**
 * Local span extraction — synchronous, runs on every assistant response
 * the moment the stream finishes. Walks the text with compromise's POS
 * tagger and pulls out the structurally important phrases a reader might
 * want to mark: noun phrases, named entities, hyphenated compounds,
 * acronyms, numeric quantities, multi-word proper noun runs.
 *
 * Each phrase is verified verbatim (case-insensitive) in the source text
 * and capped at 1-5 words.
 */
export function extractSpans(text: string): ChipSpan[] {
  if (!text.trim()) return [];

  const out: ChipSpan[] = [];
  const seen = new Set<string>();
  const lowerText = text.toLowerCase();

  function add(phrase: string): void {
    // Strip leading/trailing punctuation; also strip a possessive "'s"
    // tail so "LuckFox's" → "LuckFox" rather than the possessive form.
    let trimmed = phrase
      .trim()
      .replace(/[.,;:!?'"]+$/, '')
      .replace(/^[.,;:!?'"]+/, '')
      .replace(/['’]s$/i, '')
      .trim();
    if (!trimmed) return;
    const words = trimmed.split(/\s+/);
    const wc = words.length;
    if (wc < 1 || wc > 5) return;
    // Single-word stopwords (capitalized or not) never qualify — sentence-
    // start "The", connectives like "However", pronouns, etc.
    if (wc === 1 && STOPWORDS.has(trimmed.toLowerCase())) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    if (!lowerText.includes(key)) return; // verbatim only
    seen.add(key);
    out.push({ phrase: trimmed, question: trimmed });
  }

  // ── compromise pass: noun phrases + named entities ──
  const doc = nlp(text);

  for (const n of doc.nouns().out('array') as string[]) add(n);
  for (const p of doc.people().out('array') as string[]) add(p);
  for (const p of doc.places().out('array') as string[]) add(p);
  for (const o of doc.organizations().out('array') as string[]) add(o);

  // ── regex pass: technical compounds, acronyms, numeric units ──

  // Hyphenated compounds — "open-source", "Unix-based", "real-world",
  // "Wi-Fi", and product names like "Pi-KVM". Allow digits inside.
  const hyphenRx = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g;
  for (const m of text.matchAll(hyphenRx)) add(m[0]);

  // Acronyms — 2 to 5 ALLCAPS letters.
  const acroRx = /\b[A-Z]{2,5}\b/g;
  for (const m of text.matchAll(acroRx)) add(m[0]);

  // Numeric quantities with units — "16GB", "8 cores", "60fps".
  const numUnitRx = /\b\d+(?:\.\d+)?\s?[A-Za-z]{1,8}\b/g;
  for (const m of text.matchAll(numUnitRx)) add(m[0]);

  // ── multi-word proper noun runs ──
  // No more sentence-start skip — STOPWORDS filter handles common false
  // positives like "The", "These", "However" at sentence start. Real
  // proper nouns (TinyPilot, Apple, Linux) come through even at the
  // sentence start. Allow up to 5 tokens to catch product strings like
  // "Raspberry Pi Zero 2 W". Allow hyphens inside tokens.
  const properRx =
    /\b[A-Z][A-Za-z0-9-]*(?:\s+(?:[A-Z][A-Za-z0-9-]*|\d+[A-Za-z]?)){0,4}\b/g;
  for (const m of text.matchAll(properRx)) add(m[0]);

  return out;
}
