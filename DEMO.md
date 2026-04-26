# Demo voiceover — 3-minute script

Optimized for ElevenLabs (or any TTS). Spoken word only — no stage directions inside the spoken text, so you can paste each block straight into the synthesizer. Em-dashes render as natural pauses; paragraph breaks render as longer pauses. Total target: ~3:00 at standard pace (~390 words).

If you generate one long take, paste **the full script at the bottom**. If you want to record screen-aligned segments and stitch them, use the segment blocks (each is sized for the visual it pairs with).

---

## Segment 1 — Open with the problem · 0:00–0:18

**On screen:** title card or a quick blur of a long ChatGPT-style transcript.

```
Most chat with a model lives in a single thread. You scroll. You lose the thread. The model forgets. Every fork is destructive. river puts the conversation on a canvas, and the agent has hands inside it.
```

---

## Segment 2 — Basic flow · 0:18–1:00

**On screen:** type a real question, send. Show streaming. Tap an inline phrase chip mid-card. Hit `+` below the assistant card to branch. Right-click empty canvas → "New stream here," then dismiss.

```
Here's how it feels. You type a question. The agent's reply streams onto its own card. While it's thinking, the card shows what it's actually doing — searching the web, reading a file, creating a card. When the reply lands, you can tap any phrase to mark it as context. You can hit the small plus below any card to branch. Or right-click empty canvas to start a brand new stream, parallel to whatever's already there.
```

---

## Segment 3 — Agent as cartographer · 1:00–1:50

**On screen:** ask "give me four framings of this problem." Four cards materialize. Show the FLAGGED badge + hover reason on the most pivotal one. Ask "punch up the third card" — show it edit in place, not as a new card. Show a lateral dashed link the agent drew between two cards in different branches.

```
What makes this different is the agent's role. It isn't just a respondent. It's framed as a cartographer of the workspace. Every turn is also a chance to maintain the canvas. Watch this — when I ask for four framings of a problem, I don't get four paragraphs in one card. I get four cards, each its own artifact. The agent flags the most pivotal one with a red badge and a one-line reason on hover. When I ask it to refine the third card, it edits in place. And it draws lateral dashed links between cards in different branches that touch the same idea. The structure of the thinking, made visible.
```

---

## Segment 4 — Multi-root canvas · 1:50–2:20

**On screen:** zoom out. Show the full canvas with the existing tree on one side. Right-click empty space far to the right → "New stream here." Camera lands on the new root. Pull back so both trees are visible.

```
Everything I just did sits on one canvas. I can right-click empty space and start a second parallel investigation right next to it. Two roots, two subtrees, both alive at the same time. The canvas can hold any number of independent streams — different threads, same workspace.
```

---

## Segment 5 — Memory + autonomous wake · 2:20–2:50

**On screen:** open a card the agent flagged or a link it drew during a pre-recorded autonomous wake. Briefly show the `/mnt/memory/` contents (a few preference notes the agent has written across canvases) or a memory note inline.

```
And it remembers. Each canvas has its own persistent Managed Agent session — alive across reloads, days, multiple devices. There's a writable memory store the agent uses across all your canvases — preferences, recurring topics, durable conclusions. With autonomous wake turned on, the agent runs without me present, doing quiet cartographer passes between sessions. I come back, and the canvas has been tidied while I was away.
```

---

## Segment 6 — Close · 2:50–3:00

**On screen:** end card with project name + repo URL.

```
A maintained thinking environment, not a pile of historical turns. Built on Opus four point seven and Anthropic's Managed Agents.
```

---

## Full script (one-shot generation)

Paste the whole block below into ElevenLabs as a single take. Keep paragraph breaks intact — they render as natural pauses between segments.

```
Most chat with a model lives in a single thread. You scroll. You lose the thread. The model forgets. Every fork is destructive. river puts the conversation on a canvas, and the agent has hands inside it.

Here's how it feels. You type a question. The agent's reply streams onto its own card. While it's thinking, the card shows what it's actually doing — searching the web, reading a file, creating a card. When the reply lands, you can tap any phrase to mark it as context. You can hit the small plus below any card to branch. Or right-click empty canvas to start a brand new stream, parallel to whatever's already there.

What makes this different is the agent's role. It isn't just a respondent. It's framed as a cartographer of the workspace. Every turn is also a chance to maintain the canvas. Watch this — when I ask for four framings of a problem, I don't get four paragraphs in one card. I get four cards, each its own artifact. The agent flags the most pivotal one with a red badge and a one-line reason on hover. When I ask it to refine the third card, it edits in place. And it draws lateral dashed links between cards in different branches that touch the same idea. The structure of the thinking, made visible.

Everything I just did sits on one canvas. I can right-click empty space and start a second parallel investigation right next to it. Two roots, two subtrees, both alive at the same time. The canvas can hold any number of independent streams — different threads, same workspace.

And it remembers. Each canvas has its own persistent Managed Agent session — alive across reloads, days, multiple devices. There's a writable memory store the agent uses across all your canvases — preferences, recurring topics, durable conclusions. With autonomous wake turned on, the agent runs without me present, doing quiet cartographer passes between sessions. I come back, and the canvas has been tidied while I was away.

A maintained thinking environment, not a pile of historical turns. Built on Opus four point seven and Anthropic's Managed Agents.
```

---

## ElevenLabs settings (recommended starting points)

- **Stability:** 50–55. Lower = more expressive but risks drift; this script wants a calm, deliberate tone.
- **Similarity:** 75–80 if using your voice clone, so it stays recognizably you without losing intelligibility.
- **Style exaggeration:** 0–10. The script is plain prose; you don't need theatrical lift.
- **Speaker boost:** on if your clone has strong character; off if it sounds breathy/echoey.
- **Speed:** 1.00 default. If a one-shot lands at 3:10+, bump to 1.05 (don't go higher — clips word ends).

If you generate per-segment and stitch in a video editor, leave a 200–400ms silence pad at each segment start so cuts breathe.

## A few words flagged for pronunciation

- **river** — one-syllable name; TTS handles it cleanly with no special spelling.
- **Opus four point seven** — written that way so TTS doesn't say "four hundred and seventy".
- **Anthropic** — most clones handle this fine; if yours stumbles, try "An-thropic" with the hyphen.

## Cue order for the screen recording

When you record the screen, record in this order so the cuts in the video lock to the script segments above:

1. Cold-open with the canvas already showing one rich tree (8–12 cards, includes a flag and a lateral link). Cuts fast.
2. Type → send → stream → tap phrase → branch (~30s).
3. Multi-card output → flag appears → edit-in-place → lateral link drawn (~45s).
4. Right-click new stream → camera moves → zoom out to show both trees (~25s).
5. Memory store / wake artifact reveal (~25s).
6. End card.

Pre-warm everything before you hit record. The first turn on a fresh project takes a few extra seconds while the platform spins up the container — you don't want that on tape.
