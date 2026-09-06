# Pacific Skies

A tribute to the 1984 arcade vertical scroller genre — inspired by Capcom's **1942**, but not
affiliated with or endorsed by Capcom. Fly the P-38-style twin-boom fighter **"Super Ace"** north
across the Pacific theatre, stage by stage (**STAGE 32** counting down to **STAGE 1**), dodging
formations of enemy fighters and bombers, looping out of the plane of play to dodge incoming fire,
and collecting POW power-ups on the way to Tokyo.

This version is **online 2-player co-op** (1943-style: both planes on screen, shared scrolling,
separate scores/lives), has **accounts, achievements and a player dashboard**, an **attract-mode
title screen** with a demo flight, and a synthesized **WebAudio soundtrack** — all with **zero image
assets**: every sprite is an 8x8/16x16 pixel pattern drawn in code, arcade-style.

## Quick start

```bash
npm install
npm start            # http://localhost:3001
npm run dev           # same, but restarts on file changes (node --watch)
npm test              # unit tests (sim, stage data, auth/stats, static-server security)
npm run smoke         # Playwright: load the lobby, quick play, fly for a few seconds
npm run e2e            # Playwright: co-op join, forced stage clear + tally, dashboard/settings
```

Requires Node.js 22.5+ (uses the built-in `node:sqlite`). Data lives in `./data/pacific-skies.sqlite`.

## Controls

- **Move** — WASD or arrow keys (8-directional)
- **Fire** — Space (autofire while held, rate-capped)
- **Loop-the-loop** — Shift or Q: flips the plane out of the plane of play for ~1.2s, invulnerable
  and unable to shoot. 3 loops per life; replenished on death or by the POW loop item.
- **Mute** — M

## How to play

- Enter a callsign (or stay a guest) and **Quick Play** to join a public room still in its lobby
  (or start one), or **Create Room** for your own, or **Join via link** with a room code —
  either way you land in a **pre-game room screen** first: roster with ready state, an invite
  link (`/?room=ID`) to share, and chat. The host starts once everyone is ready (or alone); the
  room also auto-starts on a cancellable 5s countdown once everyone readies up.
- **Enemies**: small fighters in scripted formations (straight dive, sine weave, a V formation
  that sweeps in from the side, and a **red formation** of 5 planes flying a tight loop — destroy
  all 5 and it drops a POW item), medium twin-engine bombers that fire aimed shots at you, a
  **mid-boss** medium bomber partway through most stages, and a large multi-turret **boss bomber**
  on stage 32, 28, 24 ... every 4th stage. Enemy bullets are slow round shots; contact with a
  bullet or plane costs a life (unless you're looping or briefly invulnerable after a respawn).
- **POW items** cycle by pickup count, arcade-style: side-fighter escorts (two small planes flank
  you and fire alongside you) → 4-way spread shot → destroy every enemy on screen → +1 loop →
  bonus points → 1UP, then repeats.
- **32 stages** counting down from 32 to 1, each ~60–90 seconds of scripted waves. Landing on the
  carrier deck at stage end shows a stage-clear tally: shots fired, hits, accuracy %, bonus, and
  whether you cleared the stage untouched. Stage names (Midway, Marshall Islands, Attu, Rabaul,
  Leyte, Saipan, Iwo Jima, Okinawa, Tokyo, ...) are flavour text from the Pacific theatre.
  Difficulty ramps with stage: enemies get faster and fire more as you go deeper.
- **Scoring**: kills, red-formation clears, bosses, and stage-clear bonus all add up; extra lives
  at score thresholds (30k/100k/200k/400k); a hi-score is shown on the title screen. Reach stage 1
  for a victory screen.
- **This slice**: stages 32–29 are hand-authored (including the stage-32 boss); stages 28–1 are a
  deterministic escalation of the same wave vocabulary (same seed -> same stage every time), so
  the whole 32-stage run is playable end to end today, ending in a victory screen at stage 1.

## Architecture

Node 22 ESM, no build step, `ws` for the WebSocket protocol and `node:sqlite` for storage — same
approach as the sibling project this was built alongside (a Gauntlet-style dungeon crawler). An
authoritative server simulation runs at **30 Hz** (tighter than a dungeon crawler needs, because a
scrolling shooter's bullets and dodges are much less forgiving of latency); clients only send
input and render the latest broadcast snapshot.

```
shared/            constants, stage scripts (32-stage data + validation), achievements, seeded RNG
server/
  index.js          static file server + REST API (/api/*) + WebSocket protocol (/ws)
  db.js             node:sqlite connection + schema
  auth.js           register/login/session tokens
  stats.js          per-user counters + achievement unlocking
  account.js        password change, account deletion, preferences, data export
  admin.js          admin dashboard backend (overview, users, errors, analytics, room control)
  telemetry.js      first-party analytics beacon + retention sweep
  log.js            structured JSON logging + persisted error log
  client-ip.js      TRUST_PROXY-aware client IP resolution for rate limiting
  ws-heartbeat.js    WebSocket liveness sweep
  game/
    sim.js           the authoritative simulation: movement, bullets, enemies, formations,
                      loop-the-loop, POW cycle, collisions, stage scripting, boss fights
    room.js          one running flight: ties a Sim to a WS room, the 30Hz tick loop, the
                      pre-game lobby screen, and stats/achievement hooks
    lobby.js         room registry: create/find/list, quick play
client/
  index.html/game.js the whole client: title/attract screen, lobby -> room -> live game ->
                      tally/gameover, all driven by the /ws protocol
  render.js          shared renderer (background + entities) used by both the live game and
                      the title screen's attract-mode demo flight
  sprites.js         every sprite as an 8x8/16x16 pixel pattern (no image assets)
  audio.js           WebAudio synth sound effects (shots, explosions, POW jingle, boss alarm,
                      stage-clear fanfare) with a master/SFX volume mixer
  common.js          shared client helpers: auth token, API fetch, nav, toasts
  dashboard.html/js  stats, achievements, recent runs, leaderboard
  settings.html/js   volume, password change, data export, account deletion
  admin.html/js      admin dashboard
test/
  helpers/server.mjs shared spawner: boots the real server against a fresh temp DATA_DIR
  *.test.js           node:test unit suites (sim, stage data, auth/stats, static-server security)
  smoke.mjs           Playwright: load the lobby, quick play, start, fly for a few seconds
  e2e.mjs             Playwright: co-op join/ready/start with two browsers, a forced stage clear
                      via the SKIES_DEBUG=1 debug hook, the tally screen, next stage, plus the
                      dashboard and settings pages
```

Health endpoint `GET /api/health`. `TRUST_PROXY=1` honours `CF-Connecting-IP`/`X-Forwarded-For`
(only trust this behind a real proxy). Rate limits on register/login/room-creation/telemetry.
The static file server resolves every path through `path.relative()` against its base directory
(rejecting `..` traversal and encoded traversal attempts alike) and rejects NUL bytes before they
reach the filesystem layer. Request bodies are size-capped.

### Debug hook

Setting `SKIES_DEBUG=1` enables a `{ t: 'debug', roomId, action }` WebSocket message (accepted
either from a connection already in the room, or by naming the room directly so a lightweight
test helper socket doesn't have to occupy one of the room's two player slots) with actions
`clear-stage` (force the current stage to end immediately), `jump-to-boss` (skip straight to the
stage's final wave) and `win-game`. Never enabled unless the server is explicitly started with
this flag — used by `test/e2e.mjs` and for manual QA.

## Development

```bash
npm install
npm run dev      # node --watch server/index.js
```

No bundler: the client is plain ES modules served directly by the Node server (`client/*.js`,
plus `shared/*.js` served under `/shared/`). Edit and refresh.

## Testing

- `npm test` — node:test unit suites: sim (movement bounds, bullets, collisions, loop
  invulnerability, POW cycle, red-formation drop rule, boss hit points, stage-script advancing,
  co-op score/lives separation), stage data validation (every stage has a boss/mid-boss as
  specified, waves sorted by time), auth/stats, and static-server security.
- `npm run smoke` — Playwright: loads the lobby/dashboard/settings pages, quick-plays solo, flies
  and fires for a few seconds, and fails on any console error, page error, or failed request.
- `npm run e2e` — Playwright with two browser contexts: co-op room create/join/ready/start, a
  forced stage clear via the `SKIES_DEBUG=1` hook, the stage-clear tally overlay on both browsers,
  confirmation the next stage begins, and a check of the dashboard/settings pages.

## Deployment

`.github/workflows/ci.yml` runs unit + smoke + e2e on every push/PR (Node 22).
`.github/workflows/deploy.yml` deploys `main` over SSH — inert with no effect until you configure
`DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` repo secrets, in which case it runs `$HOME/deploy.sh`
on the target host if present.

### CloudPanel

The app runs as a plain Node.js site under `pm2` (no Docker). `deploy/deploy-cloudpanel.sh`:
pulls the target branch, `npm ci --omit=dev`, and restarts (or starts) the `pacific-skies` pm2
process with `PORT` and `DATA_DIR=$HOME/data` set, then polls `/api/health` until it's up. Point
CloudPanel's Node.js site at this repo, set up a symlink or copy of the script at `$HOME/deploy.sh`
on the server (or let the deploy workflow fall back to `deploy/deploy-cloudpanel.sh` directly),
and add the SSH secrets above to enable auto-deploy on push to `main`.

The app listens on `PORT` (default 3001, to avoid clashing with anything else running locally)
and stores its SQLite database under `DATA_DIR` (default `./data`).

## Credits

Inspired by Capcom's **1942** (1984) — this project is an original, non-commercial tribute and is
not affiliated with, endorsed by, or sponsored by Capcom. All code, art, and sound in this
repository are original work.
