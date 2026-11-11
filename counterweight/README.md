# Counterweight (prototype)

A two-player block game that crosses Jenga with a piece-dropping puzzle. Both
players share one 3D tower and take turns: one drops a piece on top, the other
slides a block out. Design notes are in
[`docs/counterweight-design-spec.md`](../docs/counterweight-design-spec.md) and
a player's guide is in
[`docs/counterweight-user-guide.pdf`](../docs/counterweight-user-guide.pdf).

It is separate from Route Lens and shares no code with it.

## Running it

From this folder:

```bash
python -m http.server 8420
```

Then open <http://localhost:8420/>. It needs a server because it uses ES
modules; opening `index.html` from disk will not work. There is no build step.
The physics engine (Rapier 3D, Apache-2.0) and the renderer (three.js, MIT) are
vendored in `vendor/`.

Playtest overrides go in the URL, e.g. `?rounds=6&towers=1&seed=3`.

## The game

- Turn-based, for two players at one computer. A mouse is all you need.
- Each round the **Dropper** places the piece the hand is holding, then the
  **Puller** slides one block out. Roles swap every 3 rounds.
- A tower lasts 12 rounds or until it falls. A game is 3 towers; most points wins.

| | Points |
|---|---|
| Dropper places a piece | 1 per square of the piece |
| Dropper completes a layer | +3 |
| Puller removes a block | 1, 2 or 4, by how much weight it carried |
| Blocks knocked off the tower | −2 each, to whoever moved |
| Tower falls (3 or more blocks hit the table) | −10 to whoever moved; tower ends |

Pull rules: not from the top two layers, and only if the block has a clear
straight path out. It slides towards whichever clear side faces the camera.

## Controls

| | |
|---|---|
| Drag | Look around the tower |
| Scroll | Zoom |
| Move the mouse over the tower | Aim the piece (Dropper) |
| `R` or right-click | Turn the piece |
| Click, or `Space` | Drop the piece |
| Click a coloured block | Choose it (Puller) |
| Click it again, or `Space` | Pull it out |
| `?` button | Rules |

On a touch screen a tap aims or chooses, and the on-screen buttons drop and pull.

## Code

| File | What it holds |
|---|---|
| `js/config.js` | Tuning values, piece shapes, the starting tower |
| `js/game.js` | Rules and physics. No DOM, so it also runs under Node |
| `js/view.js` | three.js scene: tower, hand, camera, picking |
| `js/main.js` | Boot, input, prompts, menus, the frame loop |
| `tests/game.test.mjs` | Headless rule checks: `node counterweight/tests/game.test.mjs` |
| `realtime2d/` | The earlier real-time 2D prototype, kept as a second mode |

## Not built yet

Sound, a computer opponent, online play, a hand for the Puller, special pieces.
