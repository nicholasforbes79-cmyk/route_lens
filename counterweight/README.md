# Counterweight (prototype)

A first playable build of Counterweight, the Jenga × Tetris game specified in
[`docs/counterweight-design-spec.md`](../docs/counterweight-design-spec.md).
Two players share one physics tower: one drops pieces on top, the other pulls
blocks out of the bottom half, and the roles swap every 60 seconds.

It is separate from Route Lens and shares no code with it.

## Running it

From the repository root:

```bash
python scripts/dev-server.py 8420
```

Then open <http://localhost:8420/counterweight/>. It needs a server because it
uses ES modules; opening `index.html` from disk will not work. There is no build
step. The physics engine (Rapier 2D, Apache-2.0) is vendored in `vendor/`.

Playtest overrides go in the URL, e.g. `?phase=20&cap=120&seed=3` for 20-second
role phases, a 2-minute tower cap and a fixed piece order.

## Controls

Two players at one computer: the Dropper has the keyboard and the Puller has the
mouse. At each swap the players trade devices.

| Dropper (keyboard) | |
|---|---|
| `A` / `D` or `←` / `→` | Move |
| `W` or `↑`, `Q` | Rotate clockwise, anticlockwise |
| `S` or `↓` | Soft drop |
| `Space` | Hard drop (lands harder the further it falls) |
| `E` | Hold |

| Puller (mouse) | |
|---|---|
| Drag a block sideways | Slide it out. Slow is safe; a fast yank drags its neighbours |
| Right-click a block | Tap test: shows its exact load, then locks you out for 0.75 s |

`Esc` pauses.

## What is in

- Rapier physics at a fixed 120 Hz step, the seven standard pieces plus Lead and Ice
- Stress tint on every block, the pull zone, hold slot and a three-piece queue
- Scoring from the spec: placements, row fusion, stress-multiplied pulls, clean
  pulls, height milestones, collapse penalty, survival bonus
- Role swap with a 10-second warning and a 3-second slow-motion freeze
- Collapse detection, blame split, best of 5 towers, loser picks the next role
- Hot-potato window that grows with tower height

## Where it differs from the spec

- **Pulling.** The view is side-on, so a block cannot slide sideways past its
  neighbours. A pull slides the block out towards the viewer instead: drag
  sideways to make progress. A half-pulled block stays half-pulled but has no
  physical effect yet.
- **Pull unit.** You pull one cell, not a whole piece. What is left of the piece
  stays welded where it still touches edge to edge.
- **Starter rows.** Each tower starts with four loose rows on the foundation so
  the Puller has work from the first second. They never fuse.
- **Returned cubes.** At most every other piece dealt is a returned cube.
  Without this the Dropper's queue fills with cubes.
- **Stress scale.** Load is measured against the cell's share of the column
  above it, so the colours show concentration, not just depth.
- **Collapse.** A collapse is 10 or more settled cells falling more than two
  cells within 1.5 seconds (the spec says 4 blocks). A single piece that falls
  off the side is not a collapse: it is removed, and if it never came to rest on
  the tower its Dropper loses 10 points. With the spec's rule, one misdropped
  piece ended the tower.
- **Walls.** The side walls cover the first 8 rows above the foundation.
- **Blame.** A simple ledger: each recent drop and pull is weighted by how risky
  it was and how long ago it happened. It does not trace the failure through the
  contact graph, and there is no trap detection, last-word bonus or replay.

Not built yet: deep pulls, slab cracking, the other special pieces, AI
opponents, online play, puzzle towers, sound.

## Code

| File | What it holds |
|---|---|
| `js/config.js` | Every tuning value, the piece shapes and the starter layout |
| `js/sim.js` | Rules and physics. No DOM, so it also runs under Node |
| `js/render.js` | Canvas drawing |
| `js/main.js` | Boot, keyboard and mouse input, menus, the frame loop |
| `tests/sim.test.mjs` | Headless rule checks: `node counterweight/tests/sim.test.mjs` |
