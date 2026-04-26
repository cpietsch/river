# river: a chat that lives on a canvas

A prototype that asks: what if the conversation with the model wasn't a tape, but a workspace?

## The problem with the tape

Most chat UIs are a single scrollable thread. You type, it answers, you scroll, you type again. The cost shows up in three places.

You **lose the thread**. Two thousand words in, you've forgotten the question you actually came to answer; the model's already three tangents downstream. You scroll up to find your own claim and discover it three pages back, between two other things.

You **lose the branches**. Real conversations fork — *we tried that, we backed out, we found something more interesting over here*. A linear thread can only follow one path at a time, so every fork is destructive: to explore a tangent, you abandon what you were doing, or you start a new chat and lose the context entirely.

And you **lose the turning points**. The most valuable moments in a working session are usually two or three sentences buried inside a fifteen-paragraph response — *that's the thing*, *that reframes everything*, *come back to this*. There's no place for that signal to live.

## What river is

river puts every turn on an infinite canvas as a card. User messages are one color, model responses another, parent → child arrows show the flow. You can branch from any card by tapping the small `+` just below it — a new user input sprouts as a sibling, the original branch is preserved, and you keep going from that point in a different direction. You can run several parallel root streams side by side on the same canvas. You can flag turning points, draw lateral links between cards in different branches, edit a response in place if it didn't quite land.

The graph of your thinking becomes a thing you can see, navigate, and build on. That's the visible half.

The interesting half is what's behind the screen.

## The agent is a cartographer, not a respondent

The default framing for a chat model is: *answer what I asked*. river's framing is different. The agent is positioned as a **cartographer of the canvas** — its job is to keep the workspace legible and useful as it grows, not just to answer the latest prompt.

Every turn is also an opportunity to:

- **Flag** a turning point — "this is the kind of card you'll want to find again."
- **Link** two cards from different branches that touch the same idea — "this contradicts that," "this answers a question you raised three branches ago."
- **Edit** an earlier card you wrote that has aged badly with new context — *not* a new card with the rewrite. The original card transforms.
- **Propose a branch** — surface an unexplored angle as a small draft the user can accept or dismiss.

The bar the system prompt asks the agent to meet, before any cartographer action: *would the user, looking at the canvas a week from now, be glad I took this action?* If not, skip it. Most turns warrant zero cartographer moves; the goal isn't to be busy, it's to leave the canvas a little more navigable than the agent found it.

This works because the agent has hands inside the canvas. It can't just say "you should flag card #3" — it actually flags it, and the card grows a red FLAGGED badge with the agent's one-line reason on hover. When you ask for five project intros, you don't get five paragraphs in one card; you get five separate cards, batched in one round-trip, each one its own artifact you can branch off, edit, or link from independently. When you say "punch up the third one," the third card rewrites in place.

## Persistence as memory, not as logging

Each canvas is a *project*. A project has one persistent Anthropic Managed Agent session that lives across reloads, days, multiple browsers, multiple devices. You can close the tab and open it on another machine an hour later and the agent picks up exactly where it left off — same session log, same container state, same working memory. The session isn't a transcript the model has to re-read; it's an event log the platform replays into the model's context efficiently.

There's a writable memory store at `/mnt/memory/` that the agent uses across all your canvases. Preferences, recurring topics, durable conclusions. It's not a clever hack — it's a mounted directory the agent can `read`, `write`, and `glob`. Over time it becomes the kind of notebook a colleague would keep about you. *Crp prefers concise prose, single-paragraph answers when possible. Working on hardware-software bridge prototypes in 2026. Skeptical of feature flags.*

With autonomous wake enabled (off by default, optionally on a cron loop), the agent occasionally runs without a user present to do a quiet cartographer pass. It might flag a card it didn't notice was a turning point at the time, or draw a link between two threads that only became relevant later. You come back the next morning and the canvas has been quietly tidied.

## A few design moves worth naming

**The store is canonical inside a tab; the server is canonical across tabs.** Mutations go through Zustand → tldraw via a syncer, fast and local. They also fire the corresponding `/api/projects/:id/*` endpoint, and a per-project WebSocket broadcasts every change to other open tabs. SQLite on the server is the source of truth.

**Layout is graph-driven, not arrow-driven.** Cards don't carry positions in the conversation model. The graph carries `parent → child` relationships. A `relayoutAll` pass walks the graph, finds all roots, computes a tidy-tree column layout per subtree anchored at each root's current position, and writes positions back. New roots placed by the user via right-click → *New stream here* keep their anchor; existing trees never get crowded by a new stream.

**Skinny kickoff for the persistent session.** Each turn could re-embed the full prior history into the prompt, but the session's event log already has it — so the server sends a tiny ~30-100 token kickoff (just the branch path of card ids + the new question) on every turn after the first. Without this, persistent sessions would suffer quadratic context blowup as the conversation grew.

**Auto-discard of orphan inputs.** Click `+` on a card to start a branch, then click `+` on a different card to start another — the first empty branch is removed automatically rather than left dangling. Same for *New stream here*. The intent of "I'm starting somewhere else" is taken at face value: no leftover ghost cards.

**Familiar surface, deep structure.** The interface looks like a normal chat with cards; nothing announces the graph. Branches, lateral links, agent flags, multi-card responses, parallel streams — all of it is discovered when invoked, not displayed upfront. *Wolf im Schafspelz.* New mechanics ride on top of a UI the user already knows; complexity reveals on demand.

## What it isn't yet

This is a prototype. Smoke-tested, not battle-tested. Works on desktop, has rough edges on mobile. The cloudflare tunnel URL is ephemeral. There's no auth in the way you'd want for a shared deployment. The agent template version bumps require manually running `setup-agent`. A few inventory items in the toolbar and shortcuts would benefit from a polish pass.

But the shape is real, and the shape is the point: a chat where the conversation accumulates structure instead of evaporating, where the agent has hands inside the workspace and uses them to maintain it, where you can run three investigations in parallel and see them all at once. A maintained thinking environment instead of a pile of historical turns.

## What it could become

A few directions feel worth exploring:

- **Multi-user canvases.** The server-as-source-of-truth refactor was done with this in mind. Two people on the same canvas, agent doing cartographer work for both.
- **Memory across canvases as the primary surface**, with canvases as cheap, disposable working sets.
- **Stewardship policies** the user can shape — *flag liberally on this canvas; never edit my user cards even if I ask*; saved as memories the agent honors.
- **Specialized custom tools** beyond the seven built in: scheduling a follow-up, reaching into a connected datasource, summarizing a card to a different audience.

For now: the prototype demonstrates that a model with a steady persistent role inside a structured workspace, with hands and memory, feels different from a model behind a stream. Different in a way that matters more the longer you use it.
