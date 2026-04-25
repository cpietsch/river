import nlp from 'compromise';
import type { ChipSpan } from '../api';

/**
 * Local span extraction — replaces the Haiku /api/chip-spans call. Walks
 * the text with compromise's POS tagger and pulls out the structurally
 * important phrases a reader might want to mark:
 *
 *  - noun phrases (compromise.nouns)
 *  - people, places, organizations (named entities)
 *  - hyphenated compounds and acronyms (regex pass)
 *  - numbers with units ("16GB", "8 cores")
 *
 * Each phrase is verified to appear verbatim in the text (case-insensitive)
 * and 1–4 words long. Returns a ChipSpan with the phrase as both the
 * `phrase` and the `question` — questions can be enriched later with a
 * Haiku call if we want hover tooltips, but the bare term works as
 * userContext too.
 */
export function extractSpans(text: string): ChipSpan[] {
  if (!text.trim()) return [];

  const out: ChipSpan[] = [];
  const seen = new Set<string>();
  const lowerText = text.toLowerCase();

  function add(phrase: string): void {
    const trimmed = phrase.trim().replace(/[.,;:!?'"]+$/, '').replace(/^[.,;:!?'"]+/, '').trim();
    if (!trimmed) return;
    const wc = trimmed.split(/\s+/).length;
    if (wc < 1 || wc > 4) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    if (!lowerText.includes(key)) return; // verbatim only
    seen.add(key);
    out.push({ phrase: trimmed, question: trimmed });
  }

  // ── compromise pass: noun phrases + named entities ──
  const doc = nlp(text);

  // Noun phrases — already filters function words, captures multi-word units.
  for (const n of doc.nouns().out('array') as string[]) add(n);

  // People / places / organizations — compromise tags these specially.
  for (const p of doc.people().out('array') as string[]) add(p);
  for (const p of doc.places().out('array') as string[]) add(p);
  for (const o of doc.organizations().out('array') as string[]) add(o);

  // ── regex pass: technical compounds, acronyms, numeric units ──

  // Hyphenated compounds — "open-source", "Unix-based", "real-world"
  const hyphenRx = /\b[A-Za-z]+(?:-[A-Za-z]+)+\b/g;
  for (const m of text.matchAll(hyphenRx)) add(m[0]);

  // Acronyms — 2 to 5 ALLCAPS letters, optionally followed by a digit/letter
  // tail ("USB-C", "M3", "Wi-Fi 7" kept as multi-word elsewhere).
  const acroRx = /\b[A-Z]{2,5}\b/g;
  for (const m of text.matchAll(acroRx)) add(m[0]);

  // Numeric quantities with units — "16GB", "8 cores", "60fps".
  const numUnitRx = /\b\d+(?:\.\d+)?\s?[A-Za-z]{1,8}\b/g;
  for (const m of text.matchAll(numUnitRx)) add(m[0]);

  // ── multi-word proper noun runs (Capitalized Word + Capitalized Word) ──
  // compromise catches most, but slip-throughs like "MacBook Pro M-series"
  // get a regex backstop. Skip sentence-start single capitalized words.
  const sentenceStarts = new Set<number>();
  for (const m of text.matchAll(/(?:^|[.!?]\s+)/g)) {
    sentenceStarts.add(m.index! + m[0].length);
  }
  const properRx = /\b[A-Z][A-Za-z0-9'-]*(?:\s+[A-Z][A-Za-z0-9'-]*){0,3}\b/g;
  for (const m of text.matchAll(properRx)) {
    const phrase = m[0];
    const wordCount = phrase.split(/\s+/).length;
    if (wordCount === 1 && sentenceStarts.has(m.index!)) continue;
    add(phrase);
  }

  return out;
}
