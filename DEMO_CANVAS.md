# Demo turn sequence — portfolio canvas

**Pre-warmed canvas: `proj_viw18nr4bf53`**. Already contains every demo move the script in `DEMO.md` needs. Resume it from the Projects menu when recording.

## What's on the canvas right now

**Left tree — the through-line investigation:**
- Root: *"I'm working on the through-line for my portfolio site… What's the through-line, in one sentence?"*
- Header response from the agent (one-paragraph framing of the territory)
- **4 candidate framings as sibling cards** (created in one `create_cards` round-trip):
  1. *You build instruments, not artifacts*
  2. *The seam between systems is your subject*
  3. *Your work lands first in the skin* — *(this one was edited in place from "You translate computation…" via `edit_card` after the user said "lead with the body")*
  4. *Liveness is your design constraint*
- **Lateral dashed link** between candidates 1 and 4, kind: *"same axis as"* (`link_cards`)
- A 5th card synthesizing 1 and 4: *"Your work is built to be activated"* — this is the fused framing the agent drafted as prose.
- **🚩 FLAGGED card on the fusion** — set by the autonomous wake while the user was away. Hover reason: *"Fuses candidates 1 and 4 into the most likely through-line — the load-bearing card if the user picks this direction."*
- A short header card from the wake action
- Active input slot at the leaf

**Right tree — the about-page intro (parallel investigation):**
- Right-click empty canvas → *New stream here* spawned this root
- Root: *"Different angle — how should I introduce myself in plain prose on the about page, not as a list of projects?"*
- Streamed response on how to write a self-introduction
- Active input slot

Both trees visible side-by-side after `zoomToFit` (or pan/zoom out manually).

## Replaying the sequence

If you need to re-create the canvas (e.g. on a different machine), here's the exact turn sequence. All turns below land below or branch from existing cards.

## Pre-state (already on canvas)

- U: *"Let's continue to work on my portfolio"*
- A: welcomes back, mentions last session's flow / scale / reflection clusters
- U: *"Pick A — invisibility"*
- A: *"Good — that's the load-bearing one…"* (this is the natural seed for everything below)

## Turn 1 — surface the through-line (script segment 2)

**User types** (under the active leaf, child of the most recent A):
> Tell me what the through-line of my five intros is, in one sentence — what makes them feel like one body of work.

**Expected agent moves:**
- Streams a tight 60–140 word answer naming the through-line.
- Likely flags this card (the one it just produced) — it's a load-bearing summary of the canvas.

**On camera:** show the activity indicator briefly, the response landing, then tap an inline phrase chip on something like *"invisible structures"* — proves chips work, and a chipped phrase rides forward into the next branch.

## Turn 2 — multi-card output via `create_cards` (script segment 3)

**User clicks `+` below the assistant card** to branch, then types:
> Give me four candidate one-sentence framings for the through-line on my portfolio site. Each a different angle — not four variations of the same line.

**Expected agent moves:**
- Streams a brief header card (1–2 sentences).
- Calls `create_cards` with 4 entries → four sibling cards materialize in one round-trip.
- Likely flags the strongest of the four (or doesn't, if its judgment is closer).

**On camera:** the 4 cards landing nearly-simultaneously is the *create_cards* moment — visually striking, and the tool round-trip is the technical bet.

## Turn 3 — in-place edit via `edit_card` (script segment 3 cont)

**User types under one of the four candidate cards (or in the active leaf below them):**
> Sharpen card #3 — make it less abstract, more sensory.

**Expected agent moves:**
- Calls `edit_card(<id of card #3>, <new content>)` — the third candidate rewrites in place. No new card.
- Streams a 1-sentence acknowledgement ("rewrote #3 leading with the texture instead of the abstraction").

**On camera:** zoom to card #3, watch the text mutate in place. This is the "tell it to soften and the card itself softens" moment.

## Turn 4 — lateral link via `link_cards` (script segment 3 cont)

**User types:**
> Compare candidate 1 and 4 — they feel like opposites. Are they?

**Expected agent moves:**
- Streams a comparison.
- Calls `link_cards(card_1, card_4, "compares with")` or `"contradicts"` — dashed light-violet arrow appears between them in different branches.

**On camera:** zoom out to show the dashed arrow connecting two cards in different subtrees.

## Turn 5 — new parallel stream (script segment 4)

**User right-clicks empty canvas to the right of the existing tree → *New stream here*. Camera lands on the new root.**

**User types in the new root:**
> Different angle — how do I introduce myself in plain prose, not as a list of projects?

**Expected agent moves:**
- Streams a response, treating this as a fresh investigation.
- Possibly calls `link_cards` between this root's response and a card from the original tree (since both touch "what I do").

**On camera:** zoom out so both trees are visible at once.

## Turn 6 — autonomous wake reveal (script segment 5)

**Trigger via API** (don't show the trigger on camera — just show the result):

```
curl -X POST http://localhost:4000/api/projects/proj_jr87l95cn5fd/wake
```

**Expected agent moves (no user present):**
- Reviews the canvas + memory store.
- Takes ONE useful action: most likely flags an under-appreciated card or draws a fresh lateral link, then writes a short header sentence.

**On camera:** zoom to the freshly flagged card or lateral link, hover the flag to show the agent's reason. This is the "while you were away" moment.

## Cleanup before recording

If the demo accumulates dud cards (typos, mis-clicks, etc.), right-click → Delete to remove them. The post-demo state should look intentional, not noisy.

## Time budget

- Turn 1: ~30s of actual model time
- Turn 2: ~45s (multi-card)
- Turn 3: ~25s (edit is fast — single card)
- Turn 4: ~25s
- Turn 5: ~30s
- Turn 6 (wake): ~45s

≈ 3.5 min of model wait time. Pre-warm the canvas before recording so the camera doesn't have to sit through it.
