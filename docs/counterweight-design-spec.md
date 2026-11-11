# COUNTERWEIGHT — Game Design Specification

**Version:** 0.2 (open questions from 0.1 resolved, see §17)
**Genre:** Physics block puzzle / competitive party game
**Platforms:** PC (Windows, macOS, Linux) first; browser build for prototyping
**Players:** 1–2 local, 2 online; single-player vs AI
**Session length:** 8–12 minutes per match

---

## 1. Concept

### 1.1 High concept
Two players share one physics-simulated tower. One **drops** falling tetromino pieces onto the top; the other **pulls** blocks out of the lower half. Both score from the same structure but want opposite things. Roles swap every 60 seconds. When the tower falls, the game works out who started the collapse, and that player loses big.

### 1.2 Design pillars
1. **Shared, contested space.** Every action changes the board for both players. There is no "my side".
2. **Delayed consequences.** The best moves look safe now and become dangerous later, ideally on your opponent's turn.
3. **Readable physics.** The simulation must feel fair. Players should be able to *see* stress and predict failure most of the time.
4. **Role symmetry over time.** Roles are asymmetric moment to moment but symmetric across a match, so it stays fair.

### 1.3 Player fantasy
"I set a trap three moves ago, swapped roles, and watched them walk straight into it."

---

## 2. Core Loop

```
Match (best of 5 towers)
 └─ Tower (ends on collapse or 6-minute time cap)
     └─ Role phase (60 s; roles swap at the end)
         └─ Action (Dropper: place a piece / Puller: extract a block)
```

1. A tower starts from a fixed **foundation** (a 3-row base of pre-placed pieces).
2. The **Dropper** places pieces while the **Puller** extracts blocks. Both act at the same time, in real time.
3. Every 60 seconds a **swap** happens: a 3-second freeze with a camera flourish, then the roles invert.
4. The tower ends when a **collapse** is detected (§5) or the time cap hits.
5. Points are tallied, blame is assigned, and the next tower starts with the loser of the previous tower choosing their starting role.

---

## 3. The Tower & Playfield

| Property | Value | Notes |
|---|---|---|
| Well width | 10 cells | Classic width keeps Tetris instincts relevant |
| Cell size | 1 unit (≈48 px at 1080p) | |
| Foundation | 3 rows, fixed pattern per stage | Static, can't be pulled |
| **Drop zone** | Top of the tower and above | Dropper's interaction area |
| **Pull zone** | Rows from the foundation up to 50% of the current tower height | Recalculated every second; shown as a shaded band |
| **Neutral band** | Between the pull zone and the top 3 rows | Off limits to normal actions; it is where traps "mature". The Puller can reach into it only with a costly **deep pull** (§4.4) |
| Side walls | Present up to 8 rows, then open | Tall towers have no walls to lean on, which escalates risk |

The camera follows the tower's height and keeps both zones on screen. Split focus is shown by highlighting each player's cursor colour (Dropper amber, Puller teal).

---

## 4. Roles & Controls

### 4.1 Dropper
- Gets pieces from a **queue of 3 visible pieces** (7-bag randomiser for fairness).
- Pieces spawn above the tower and fall at a **controlled speed** (they are kinematic until released).
- **Move / rotate** while falling, as in Tetris. On release or contact the piece becomes fully dynamic.
- **Hard drop** is allowed, but impact force scales with drop height. Slamming pieces shakes the tower.
- **Hold slot:** one piece, like modern Tetris.

| Action | Keyboard (P1) | Gamepad |
|---|---|---|
| Move | A / D | Left stick / D-pad |
| Rotate CW / CCW | W / Q | A / B |
| Soft drop | S | Down |
| Hard drop | Space | RT |
| Hold | E | LB |

### 4.2 Puller
- Moves a **grabber cursor** over blocks in the pull zone.
- **Grab** locks onto a block. **Pull** is a drag gesture: the block slides out along the axis you drag in. Speed matters, because fast pulls drag neighbours with them through friction.
- A pulled block is **banked** (scores) and also goes into the Dropper's queue as a **returned piece** at position 3 (see §6.3). What you pull out comes back.
- **Tap test:** a quick tap nudges a block and shows its *give* (how loose it is) at a small time cost (0.75 s lockout).

| Action | Mouse (P2) | Gamepad |
|---|---|---|
| Move cursor | Mouse | Right stick |
| Grab / pull | Hold LMB + drag | Hold RT + stick |
| Tap test | RMB | X |
| Release (abort) | Release before 50% out | Release RT |

Aborting a pull partway leaves the block sticking out, which is legal and a tactic for setting up instability.

### 4.3 Simultaneity
In local and live online play, both players act in real time. The physics sim runs continuously, so a Puller can yank a block *while* a piece is landing. That moment is a major source of drama and has to be deterministic (see §10). The online **async** mode uses alternating turns instead (§9.5).

### 4.4 Deep pull (neutral-band escape valve)
The Puller may extract a block from the neutral band as a high-risk option, for example when the pull zone has been fused solid or everything in it is red.

- **Cost:** −40 points, paid when the grab starts (not refunded if the pull is aborted).
- **Reward:** the normal extraction score with its stress multiplier (§7.1), so only a yellow or red block pays back the cost.
- **Blame weight:** a deep pull counts ×1.5 in the blame ledger (§5.2).
- **Cooldown:** 10 s between deep pulls.
- **Control:** hold the modifier (Shift / LT) while grabbing; the neutral band lights up while it is held.
- The top 3 rows stay untouchable.

All four numbers are starting values for playtesting.

---

## 5. Collapse & Blame

### 5.1 Collapse detection
A collapse is declared when **either**:
- ≥ 4 blocks (excluding the one being pulled) fall below their resting height by > 2 units within 1.5 s, **or**
- any block touches the floor outside the well.

Small settles and wobbles are **not** collapses. This tolerance is essential for fairness.

### 5.2 Blame physics (signature system)
The game keeps a rolling **causal ledger** of the last 20 seconds:

1. Every action (piece landing, pull, tap test, hard-drop impact) is logged with timestamp, actor and affected bodies.
2. Every frame, the sim records **contact-force deltas** between bodies.
3. On collapse, the system walks backward from the first falling block through the contact graph and finds the actions that **most increased stress along the failure path**.
4. Blame is split as a percentage between the players, weighted by contribution and **decayed by age**: an action from 15 s ago counts less than one from 2 s ago, *unless* it raised stress above 80% on a load-bearing block (a "trap" action, decay halved).

**Output:** e.g. *"Collapse: 70% Teal (pull at 0:42), 30% Amber (heavy block at 0:31)."*

### 5.3 Blame replay
After every collapse there is a 6-second **slow-motion replay**. It highlights the causal chain with arrows and stress colours and ends on the "fatal move" card. Skippable, but always saved to the match recap. This is the main teaching tool and the main source of shareable moments.

---

## 6. Blocks & Pieces

### 6.1 Standard pieces
The seven tetromino shapes (I, O, T, S, Z, J, L), built from rigid unit cubes welded into one body. Base density 1.0, friction 0.6, restitution 0.05 (very little bounce).

### 6.2 Special pieces (Dropper only)
Each special piece replaces a normal piece in the queue. **Frequency:** one guaranteed per 8 pieces, chosen from the stage's pool.

| Piece | Effect | Counterplay |
|---|---|---|
| **Lead** | Density 3.0. Huge downward load | Puller targets blocks *not* under it, or uses its weight to pin blocks for safe pulls nearby |
| **Ice** | Friction 0.1 | Blocks touching it slide out easily, which helps the Puller but risks sliding loads |
| **Glue** | Bonds to everything it touches after 2 s | Locks a region; it becomes unpullable but rigid |
| **Spring** | Stores impact energy and releases a small upward pulse 3 s after landing | Timing trap. Can loosen blocks during the opponent's phase |
| **Ghost** | Weightless for 10 s, then gains full density | Delayed load. Pure trap-setting |
| **Brace** | A 1×3 beam with very high friction | Defensive. Stabilises a weak column |

### 6.3 Returned pieces
Blocks the Puller extracts come back to the Dropper's queue **as single 1×1 cubes** (or as the original tetromino if pulled whole). This keeps the material economy loosely circular and gives the Dropper small "patch" pieces for repairs.

### 6.4 Stress visualisation
Every block is tinted by **normalised load** (sum of contact forces ÷ the block's own weight × a stage constant):

- **Blue** (< 30%): safe, low value
- **Green** (30–60%)
- **Yellow** (60–80%)
- **Red / pulsing** (> 80%): load-bearing, high value, high risk

There is also a colourblind palette (blue → orange with a hatch pattern on red) and an option to show numeric percentages.

### 6.5 Slab cracking
Fused slabs are not permanent. This stops heavily fused towers from stalling into time-cap draws.

1. Each slab has a **crack threshold**: a load of 6× its own weight (starting value).
2. If the load stays above the threshold for **3 s**, visible cracks appear and a cracking sound plays. This is the warning stage; the slab still behaves as one body.
3. If the load stays above the threshold for a further **5 s**, or ever exceeds 150% of it, the slab **shatters** into its 10 individual unit cubes. They are ordinary blocks again: pullable, and able to shift.
4. If the load drops back below the threshold during the warning stage, the cracks stay visible but the timer resets. A cracked slab that is loaded again shatters after 3 s instead of 5.
5. The +50 fusion bonus is kept. A shatter is logged in the blame ledger against the actions that raised the slab's load.

Effect on play: every row fused low in the tower becomes a slow fuse as the tower grows, and Lead pieces become a way to break an opponent's slab on purpose.

---

## 7. Scoring

### 7.1 Per-action points

| Action | Points |
|---|---|
| Dropper: piece placed and still resting after 3 s | 10 |
| Dropper: **row completion** (a full 10-wide row at rest) | +50, and the row **fuses** into a slab (unpullable and very stable, until it cracks: §6.5) |
| Puller: block extracted | 10 × stress multiplier (Blue ×1, Green ×2, Yellow ×4, Red ×8) |
| Puller: clean pull (no neighbour moved > 0.2 units) | +5 |
| Puller: **deep pull** from the neutral band (§4.4) | −40 up front, then the normal extraction score |
| Either: **Height milestone** (every 5 rows) | +25 to both players (shared incentive) |

### 7.2 Collapse penalty
- **Base penalty:** −150, split according to the blame percentages.
- **Survival bonus:** if the tower reaches the 6-minute cap without collapsing, both players get +100.

### 7.3 Tower and match results
The player with the higher score wins the tower. The match is **best of 5 towers**. Tiebreaker: whoever carried less total blame.

### 7.4 Tension check
Row fusion is a deliberate tension point. It earns the Dropper points and stability but **removes pullable material** from the Puller, and in 60 seconds the Dropper becomes the Puller. Fusing too much starves your own future self.

---

## 8. Swap Mechanics

- A **swap** happens every **60 s**. A 10-second warning appears as a ring timer around both cursors.
- **On swap:** a 3-second freeze (physics continues at 25% speed, so you can watch the tower settle but not act). Cursors trade colours, the camera reframes, and the Dropper's queue is kept.
- **Hot potato rule:** a collapse shortly after a swap ignores the post-swap player's actions for blame, which stops people from instantly losing to a trap they couldn't see. The window **scales with tower height**, because a taller tower takes longer to read and longer to finish settling:

  | Tower height | Window |
  |---|---|
  | Up to 10 rows | 2.0 s |
  | Each further 5 rows | +0.5 s |
  | Cap (40 rows and above) | 5.0 s |
- **Last-word bonus:** in the final 5 s before a swap, a Dropper's placements count double for "trap" detection in blame, which encourages and rewards setting up for your opponent.

---

## 9. Modes

### 9.1 Versus (core)
1v1 local (shared screen) or online. The ruleset in §§2–8.

### 9.2 Solo vs AI
An AI opponent with a visible **personality**, chosen before the match:

| Personality | Puller behaviour | Dropper behaviour |
|---|---|---|
| **Greedy** | Goes for red blocks | Fuses rows aggressively for points |
| **Cautious** | Pulls only blue and green blocks, with clean pulls | Builds flat and stable |
| **Saboteur** | Leaves half-pulled blocks sticking out | Saves Ghost and Spring pieces for just before the swap |
| **Chaotic** | Random, fast, tap-tests often | Hard-drops everything |

The AI evaluates candidate moves by running short (0.5 s) **look-ahead physics sims** on a cloned world. Difficulty scales with how many candidates it tests and how far ahead it simulates.

### 9.3 Puzzle Towers (single-player campaign)
40 hand-made scenarios, e.g. *"Extract 6 red blocks without collapse"*, or *"The AI pulls next. Place 4 pieces so it collapses within 20 s."* This teaches the systems one at a time.

### 9.4 Party variant (3–4 players, stretch goal)
One Dropper vs a team of Pullers, or two Droppers competing over who builds the tallest tower while one shared Puller works the bottom.

### 9.5 Online async (alternating turns)
A correspondence-style online mode for players who are not online at the same time. Local and live online Versus stay real-time.

- **Turn structure:** the Dropper places one piece, the tower settles (the sim runs until every body sleeps, up to 5 s), then the Puller makes one pull or passes, and the tower settles again. That is one **round**.
- **Swap:** roles swap every **6 rounds** instead of every 60 s.
- **Blame:** age decay is measured in rounds, not seconds (half-life of 2 rounds). The hot-potato window becomes "the first action after a swap", extended to the first 2 actions above 25 rows.
- **Last-word bonus:** applies to the Dropper's final placement before a swap.
- **Time-based pieces** convert to rounds: Spring fires after 1 round, Ghost gains its weight after 2 rounds, Glue bonds at the end of the round it lands in. Slab cracking (§6.5) uses 1 round of warning, then shatters on the next round if still overloaded.
- **Turn timer:** 24 hours per action by default; a missed turn is a forfeit of the tower. A "live" setting of 30 s per action is available for the same ruleset.
- **Tower cap:** 40 rounds instead of 6 minutes.
- **Tech:** each turn is a seed + one input, re-simulated on both clients and verified by checksum. No lockstep or rollback is needed, which makes this the cheapest online mode to ship first.

---

## 10. Physics & Technical Requirements

### 10.1 Engine
- **Prototype:** browser, TypeScript + **Rapier** (WASM, deterministic) or Matter.js for a first quick spike.
- **Production:** Godot 4 with Jolt, or Unity with a fixed-point deterministic layer if online play needs lockstep.

### 10.2 Determinism (required for online play and replays)
- Fixed timestep: **120 Hz** physics, rendering interpolated.
- All inputs are timestamped to the physics tick. Online play uses **lockstep with input delay** (≈ 3 ticks) plus rollback for cursor movement only (not physics).
- Replays store the seed + input log, not body states.

### 10.3 Stability tuning
- Limit the solver to a predictable iteration count (e.g. 8 velocity / 3 position).
- **Sleep thresholds** must be generous: a resting tower must not jitter itself to death.
- Blocks in fused slabs merge into one compound body (better performance and stability).
- Cap at ~250 active bodies. Fusing keeps the count down naturally.

### 10.4 Stress computation
Per tick, sum the absolute normal impulses on each body ÷ (mass × g × dt). Smooth with a 0.25 s exponential moving average so the colours don't flicker.

### 10.5 Blame ledger
A ring buffer of the last 20 s of actions + a sparse contact-graph snapshot every 6 ticks. On collapse, run a weighted backward BFS from the first displaced bodies (budget: < 50 ms).

---

## 11. UX & Presentation

### 11.1 HUD
- Top: both scores, the tower number (e.g. "Tower 3 / 5"), the swap ring timer.
- Left: the Dropper's queue + hold slot.
- Right: the Puller's bank (pulled blocks stacked like trophies).
- Tower: the stress tint on every block; the pull zone as a translucent teal band.

### 11.2 Feel & feedback
- **Creaks:** audio pitch rises with the stress on the block under the Puller's cursor.
- **Micro-shake:** the camera shakes slightly on hard drops, scaled by impact.
- **Near-miss flash:** if a pull causes a wobble that recovers, the screen edge flashes and a "CLOSE!" sound plays (and a stat ticks up).
- **Collapse:** time drops to 30%, the music cuts out, then the blame replay starts.

### 11.3 Art direction
Clean, tactile, toy-like. Matte painted-wood blocks, soft shadows, a warm workshop backdrop. Readability first: stress colours must stay legible against every block material.

### 11.4 Audio
Wooden clacks for placements, sliding friction for pulls, rising string tension tied to the tower's *global* stress. Swaps get a distinct two-note sting.

---

## 12. Onboarding

1. **Tutorial 1 (Dropper):** place pieces, see stress colours, complete and fuse a row.
2. **Tutorial 2 (Puller):** tap test, clean pull, why red blocks score more.
3. **Tutorial 3 (Swap):** play 2 phases against a Cautious AI with a guided trap.
4. **Tutorial 4 (Blame):** watch a scripted collapse replay and identify the fatal move (multiple choice).

Target: a new player can play a full match within **5 minutes** of first launch.

---

## 13. Progression & Retention (post-MVP)

- **Cosmetics only:** block materials (stone, glass, candy), grabber skins, collapse effects. No gameplay advantage.
- **Stat cards:** total blame taken, best trap (most points taken from an opponent's collapse), cleanest puller rating.
- **Daily tower:** a fixed seed and foundation, solo vs AI, with a global leaderboard.
- **Ranked online:** Elo-style rating, best of 3 towers for shorter ranked matches.

---

## 14. Balancing Levers

| Lever | Default | Effect when raised |
|---|---|---|
| Swap interval | 60 s | Longer = more strategic, fewer trap swings |
| Pull-zone height | 50% | Bigger = Puller is stronger, collapses come sooner |
| Special-piece frequency | 1 per 8 | More chaos |
| Collapse penalty | −150 | Makes players more cautious |
| Blame age decay | half-life of 6 s | Longer half-life = traps pay off more |
| Red multiplier | ×8 | Encourages risky pulls |
| Fusion bonus | +50 | Stronger stabilising incentive for the Dropper |
| Deep-pull cost | −40 | Neutral band is used less; fused towers are harder to escape |
| Slab crack threshold | 6× slab weight | Slabs last longer; more time-cap finishes |
| Hot-potato window | 2 s + 0.5 s per 5 rows (cap 5 s) | More protection after a swap; traps pay off less |
| Async swap interval | 6 rounds | Longer = more strategic |

Every lever is exposed in a **custom rules** menu for local play and for playtesting.

---

## 15. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Physics feels random or unfair | Generous collapse threshold, stress tint, tap test, blame replay that explains *why* |
| Blame feels wrong | Always show the replay with a causal chain; tune with playtest surveys ("Was the blame fair?" ≥ 80% yes is the target) |
| Dropper role feels passive | Special pieces, last-word bonus, row fusion scoring |
| Desync online | Deterministic engine, lockstep, checksum every 60 ticks with automatic resync from the host |
| Local split attention is hard | Distinct cursor colours, audio panning per role, optional "focus assist" that dims the zone you aren't acting in |

---

## 16. MVP Scope (prototype milestone)

**In:**
- Browser build, local 2-player on one keyboard + mouse
- 7 standard pieces + Lead and Ice
- Stress tint, pull zone, swap timer
- Collapse detection + simple blame (last-action heuristic, then the full ledger)
- Scoring and best-of-5

**Out (later milestones):** online play (async alternating-turn mode first, then live), deep pulls, slab cracking, AI personalities, puzzle campaign, remaining special pieces, cosmetics, replays saved to disk.

**MVP success criteria:**
1. Playtesters can explain why a collapse happened after watching the replay (≥ 4/5 testers).
2. Matches produce at least one "trap" moment (a collapse blamed > 50% on a non-acting player) in ≥ 50% of towers.
3. Players ask for "one more tower".

---

## 17. Design Decisions (resolved from v0.1)

| Question | Decision | Where |
|---|---|---|
| Can the Puller pull from the neutral band at a heavy point cost? | **Yes.** A "deep pull" costs 40 points up front, carries ×1.5 blame and has a 10 s cooldown | §4.4, §7.1 |
| Real-time or alternating turns for an online async mode? | **Alternating turns** for async online. Local and live online stay real-time | §9.5 |
| Should fused slabs eventually crack under load? | **Yes.** Sustained overload cracks a slab, then shatters it back into single cubes | §6.5 |
| Should the hot-potato window scale with tower height? | **Yes.** 2 s up to 10 rows, +0.5 s per further 5 rows, capped at 5 s | §8 |

## 18. Open Questions

1. Should the deep-pull cost rise with each use in a tower, to stop a leading Puller from spamming it?
2. Should a shattered slab be able to re-fuse if its row is still complete and the load drops?
3. In async mode, can the Puller pass without limit, or is there a cap per role phase?
