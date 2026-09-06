# Route Lens

Pick a start and an end point on a map, and Route Lens tells you where you are
along the way — as a fraction, and as some completely different journey.

Walk 10 km and you are crossing the solar system: Mercury at 98 m, Jupiter at
1.3 km, Neptune at 7.6 km. Or you are falling to the bottom of the Mariana
Trench, or living through 4.5 billion years of Earth's history. Alerts are
spoken aloud, so the phone can stay in your pocket.

An installable PWA. No build step, no dependencies to install — plain ES
modules and Leaflet from a CDN.

## Running it locally

```bash
python scripts/dev-server.py 8420
```

Then open <http://localhost:8420>. The dev server forbids caching on purpose:
with no build step there is no content hashing, so a cached module will
otherwise outlive several edits.

Open <http://localhost:8420/tests.html> to run the geometry and engine tests.
They run in the page and need no tooling.

## Getting it on a phone

Geolocation, wake lock, service workers and PWA install **all require HTTPS**.
`http://192.168.x.x:8420` is not a secure context, so the app will not work
over plain LAN — it has to be hosted. See the deploy section below.

Once it is on an HTTPS URL, open it in Chrome on Android and choose *Add to
home screen*.

### Routing

Routes come from [OpenRouteService](https://openrouteservice.org). The free
tier needs no card. Paste your key into **Settings** — it is stored in
`localStorage` on that device only and is never committed to this repo.

Without a key the app still works, drawing a straight line between your two
points, which is fine for trying things out.

## What it does

- **Fractions.** Any denominator you like. Ask for quarters, every 10%, or
  every 1/14th, and get told when you cross each one.
- **Lenses.** A lens reframes the route as another journey. Six ship built in:
  the solar system, the inside of an atom, ocean depth, Earth's history,
  Everest, and a marathon. They are plain JSON in `lenses/`.
- **Live tracking.** Your position is snapped onto the route polyline to work
  out how far along you are, with alerts spoken, vibrated and shown on screen.

### A note on scales

A lens maps its own distances onto your route. Linear is the honest mapping and
is usually right — on a Sun-to-Pluto route the planets land at 1%, 1.8%, 2.5%,
3.9%, 7%, 13%, 24%, 49%, 76%, 100%, which is well spread, and the four inner
planets bunching into the first 4% *is* the interesting fact.

Where linear genuinely fails is the atom: a proton radius of 0.84 fm against a
Bohr radius of 52,918 fm means the nucleus ends at 0.0016% and then nothing
happens at all. So lenses can also declare `power`, `log` or `rank` scales. The
app shows a prompt when a linear lens is badly bunched, and always displays the
true proportion alongside, so a non-linear scale never pretends the pacing is
real.

## Layout

```
index.html          the three screens: plan, milestones, live journey
tests.html          85 assertions, run in the browser
js/geo.js           haversine, cumulative table, route snapping   <- the core
js/milestones.js    compiles fractions + lenses; arm/fire machine
js/lenses.js        lens validation and the four scales
js/tracker.js       watchPosition -> progress along the route
js/route.js         the OpenRouteService boundary
js/simulator.js     fake GPS, so this is testable indoors
js/alerts.js        speech, vibration, wake lock
js/storage.js       settings in localStorage, the rest in IndexedDB
lenses/*.json       the built-in lenses
```

`js/geo.js` is pure and imports nothing. Everything else depends on it.

Add `?debug=1` to the URL to expose `window.RouteLens`, which can drive a whole
simulated journey through the live screen without moving.

## Known limits

- **With the screen off, Android suspends the page and tracking stops.** Keep
  the screen on during a journey (there is a wake-lock toggle in Settings) and
  listen for the spoken alerts. True background tracking needs a native
  wrapper.
- Near the turnaround of an out-and-back route the two legs are geometrically
  identical, so progress can be off by a hundred metres or so for a few fixes
  before it settles. This is inherent, not a bug, and it self-corrects.
- Tiles come from OpenStreetMap's public servers, which is fine for personal
  use but not for anything heavier.
