# The Cantor interface

Everything after the onboarding. The v1 UI in `src/screens/MainScreen.tsx` and
`src/features/*` was built to exercise the node and the relay; it is a console,
not a product, and this is the design that replaces it.

| Document | What it settles |
| --- | --- |
| [`design.md`](design.md) | The zoom model: levels, gestures, lenses, arrangements, playlists, the symbol grammar, the motion budget |
| [`structure.md`](structure.md) | Where every file goes, what each one owns, and the dependency rules |
| [`milestones.md`](milestones.md) | Execution order, phase 1 and phase 2, with the protocol work called out |

Read [`../refactor/hacking-app.md`](../refactor/hacking-app.md) first for the
app's dependency direction, and `cantor/AGENTS.md` before touching motion.
Neither is repeated here.

## The one-paragraph version

Navigation is **scale**, not place. There are no tabs: explore, library and
player are three distances from the same object, and you move between them by
zooming. A song being generated is a mark in the field drawing itself in, so
the queue is not a screen. The composer descends from the top at any level and
your caption condenses into the mark it becomes. Engines rise from the bottom.
The breadcrumb is the Cantor set itself, showing which third you are inside.

## The working prototype

`reports/cantor-zoom-mockup.html` (untracked) is a runnable prototype of the
whole model — four levels, three lenses, four arrangements, placements,
playlists, generation-as-marks, and the pairing flow. It is the reference for
behaviour when this document is ambiguous. Open it before implementing a level.

Its camera maths, fitted field scale, level bands and crossfade windows are the
ones specified here, and they were verified by driving 139 frames across every
arrangement, scale and lens. Port them; do not re-derive them.
