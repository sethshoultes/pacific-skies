# Squallkite

Weather-courier kites carry sealed storms between the glass towers of a sky archipelago; rogue
lightning drones and cloud-eating dreadnoughts want them back. A vertical shooter on a pure, seeded
engine that humans and the AI pilot play through the same typed `Action`, on stages the AI drafts
and checks for fairness before anyone flies them. (The repo and subdomain keep the old *Pacific
Skies* name until the rename in pacific-skies#5 PR5.)

## Quick start

```bash
npm install
npm start            # http://localhost:3001
npm run dev          # same, but restarts on file changes (node --watch)
npm test             # node:test suites: engine, AI, builder, rooms over real sockets, client, server
npm run smoke        # Playwright: a solo flight, quick play, a few seconds of online flight
npm run e2e          # Playwright: two browsers in one co-op room, a mid-match resume, dashboard/settings
```

Requires Node.js 22.5+ (uses the built-in `node:sqlite`). Data lives in `./data/pacific-skies.sqlite`.

## Controls

- **Steer** with arrows or WASD (8 ways), **fire** with Space, **dash** with Shift (a short
  invulnerable slip on a cooldown), **M** for sound.
- On a phone, drag anywhere to steer (the kite follows the finger's travel, so the thumb never
  covers it); it fires by itself, and the round **Dash** button slips through.

## How to play

- **Fly solo** or **Watch the AI** right on the title card: these run in the page, offline, on six
  stages the AI built and checked while you read the title.
- **Fly online**: pick a callsign (or stay a guest), then **Quick play** (the fullest open room, or
  a new one), **Create room**, or type a **room code**. The room lobby shows the roster, the invite
  link (`/?room=CODE`), chat, Ready, and the host's choice of match:
  - **Co-op**: two kites, one score (flies solo if nobody joins);
  - **Race**: two kites, separate scores, the higher wins;
  - **AI wingman**: you and an AI kite, one score;
  - **AI rival**: you against an AI kite;
  - **Watch AI vs AI**: two AI kites while you watch.
  The host starts it, or it starts on a 5 s countdown once everyone is ready. A dropped player has
  30 s to come back to the same seat (a reload does it). Lost kites get up to three continues per
  room, from the stage where they fell, with the score banked.

## Architecture

Node 22 ESM, no build step, `ws` for the WebSocket protocol and `node:sqlite` for storage. The
server runs each room's match on the engine at 30 Hz; players send Actions and draw snapshots.

```
shared/
  engine/           the pure engine: createMatch / legalActions / step / observe, a typed Action,
                    seeded RNG in the state, no clock
  ai/               the pilot (easy/medium/hard by look-ahead), headless AI vs AI, and the stage
                    builder (draftStage, checkStage by bot runs, buildStage)
  achievements.js   achievement catalogue
  constants.js      MAX_PLAYERS
server/
  index.js          static files + REST API (/api/*) + WebSocket protocol (/ws) and its caps
  game/
    room.js         one room: lobby (roster, ready, countdown, kick, chat, match type), then a match
                    on the engine with one Action per seat a tick; AI seats ask the pilot
    lobby.js        room registry: create/find/list, quick play, room caps
    stages.js       one worker thread (build-worker.js) builds every room's stages off the tick loop
  db.js, auth.js, stats.js, account.js, admin.js, telemetry.js, log.js, client-ip.js, ws-heartbeat.js
client/
  index.html, main.js  the page: title, offline solo/watch, the online room lobby and match
  online.js         the room socket and the room-lobby card
  render.js         draws a frame from match state (painterly sky, kites, drones, dreadnoughts)
  input.js, audio.js, lore.js, build-worker.js, stormglass.css
  dashboard, settings, admin (+ common.js, style.css)  accounts, stats and achievements
test/
  helpers/server.mjs  boots the real server against a fresh temp DATA_DIR
  *.test.js           node:test suites
  smoke.mjs, e2e.mjs  Playwright passes (E2E_SHOTS=<dir> saves lobby and co-op screenshots)
```

### The room protocol

Client to server: `join` (`name`, `create`, `roomId`, `resumePid` + `resume`), `type` (host:
`type`, `level`), `ready`, `start`, `act` (`a`: an `Action`, `{ move: 0..8, fire, dash }`, which must
be in `legalActions` for the sender's seat right now), `chat`, `kick`, `continue`, `leave`. Anything
else is refused. Server to client: `joined`, `roster`, `countdown`, `starting`, `start` (stages and
seats), `snap` (the seat's `observe()` snapshot, rounded, plus the tick's events), `gameover`,
`continued`, `chat`, `achievement`, `kicked`, `error`.

`SKIES_STAGES` (stages per match, default 6) and `SKIES_TICK_MS` (default 1000/30) shorten matches
for `test/rooms-ws.test.js`. Health endpoint `GET /api/health`. `TRUST_PROXY=1` honours
`CF-Connecting-IP`/`X-Forwarded-For` (only behind a real proxy).

## Deployment

`.github/workflows/ci.yml` runs unit + smoke + e2e on every push/PR (Node 22).
`.github/workflows/deploy.yml` deploys `main` over SSH — inert with no effect until you configure
`DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` repo secrets, in which case it runs `$HOME/deploy.sh`
on the target host if present.

### Go-live checklist

Nothing is live until the three deploy secrets exist, so in order:

1. On the CloudPanel host, create a Node.js site for the game's domain, clone this repo into its
   `htdocs/<domain>` directory as the site user, and install Node 22.5+ (nvm is picked up by the
   deploy script if present) plus `pm2` (`npm i -g pm2`).
2. Copy or symlink `deploy/deploy-cloudpanel.sh` to `$HOME/deploy.sh` for that user and run it once
   by hand: it does `npm ci --omit=dev`, starts the `pacific-skies` pm2 process on `PORT` (default
   3001) with `DATA_DIR=$HOME/data`, and polls `/api/health` until it answers. Run `pm2 startup` so
   the process survives a reboot.
3. Point the CloudPanel site's reverse proxy at `127.0.0.1:3001` (WebSockets on `/ws` must be
   proxied too -- CloudPanel's Node.js site template already does this) and set `TRUST_PROXY=1` in
   the pm2 environment so rate limits see real client IPs. Set `SKIES_ADMINS` to the usernames that
   should see the admin dashboard; with it unset, nobody is an admin.
4. In the GitHub repo settings add the secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (and
   `DEPLOY_PORT` if SSH isn't on 22). From then on every push to `main` that passes the unit tests
   redeploys; `workflow_dispatch` on the Deploy workflow deploys any branch on demand.
5. Verify with `E2E_BASE_URL=https://<your-domain> npm run e2e` from your machine.

### CloudPanel

The app runs as a plain Node.js site under `pm2` (no Docker). `deploy/deploy-cloudpanel.sh`:
pulls the target branch, `npm ci --omit=dev`, and restarts (or starts) the `pacific-skies` pm2
process with `PORT` and `DATA_DIR=$HOME/data` set, then polls `/api/health` until it's up. Point
CloudPanel's Node.js site at this repo, set up a symlink or copy of the script at `$HOME/deploy.sh`
on the server (or let the deploy workflow fall back to `deploy/deploy-cloudpanel.sh` directly),
and add the SSH secrets above to enable auto-deploy on push to `main`.

The app listens on `PORT` (default 3001, to avoid clashing with anything else running locally)
and stores its SQLite database under `DATA_DIR` (default `./data`).
