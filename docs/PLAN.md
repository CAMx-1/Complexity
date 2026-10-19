# Complexity — Project Plan

An Alexa custom skill that plays **video** from your own Plex Media Server on
an Echo Show by voice and touch, built first for the Echo Show 11. Music is
out of scope, because Plex music players for Alexa already exist (for
example, My Media for Alexa and Bock Media).

## Why now

Plex removed its official Alexa skill from the store in early 2026 and
disabled it completely on June 15, 2026 (forums.plex.tv/t/938054). There is no
first-party way left to watch Plex by voice on an Echo Show.

## Target device: Echo Show 11 (2025)

- 10.95" Full-HD touchscreen (1920×1200), stereo speakers and woofer, AZ3 Pro
  chip.
- Ships "designed for Alexa+". Classic custom skills still run on Alexa+
  devices, but voice routing goes through the LLM front end. M0 checks this
  on the device.

## Core design decisions

1. **No self-hosted component and no tunnel.**
   - The skill backend runs in the cloud: Alexa-hosted (free, Lambda with
     S3/DynamoDB) or our own AWS Lambda.
   - It talks to the user's Plex server the way any Plex client does, through
     **Plex Remote Access** as already published by the server.
2. **Server discovery through plex.tv.**
   - `GET https://clients.plex.tv/api/v2/resources?includeHttps=1` returns
     each server's connections.
   - Remote connections appear as `https://<ip-dashed>.<hash>.plex.direct:<port>`
     and carry a **valid, publicly trusted certificate**.
   - Pick the first remote connection that answers `/identity`.
3. **The Echo streams straight from Plex.**
   - The video URL handed to the Echo is a Plex universal-transcoder HLS
     URL: H.264 + AAC, sized to 1080p or the source if smaller.
   - It is authorised with a **transient token** (`GET /security/token?type=delegation&scope=all`).
     That token is valid for 48 h and dies on a server restart, so the
     long-lived Plex token never appears in a URL sent to Amazon.
4. **Plex sign-in without account linking.**
   - Plex has no third-party OAuth, so Amazon's account linking doesn't apply.
   - Instead we use Plex's **PIN flow** over voice and screen: "Go to
     plex.tv/link and enter **K7QX**."
     1. The skill calls `POST /api/v2/pins` and displays the code with APL.
     2. It polls until `authToken` is set.
     3. It stores the token per Alexa `userId` in the skill's DynamoDB table,
        which AWS encrypts at rest. Alexa-hosted gives no KMS access.
   - We register a JWT device key (Ed25519 `jwk` on the PIN request), the
     newer Plex auth method, so access can be revoked per device.
5. **Playback UI: an APL `Video` component, not `VideoApp.Launch`.**
   - APL gives our own transport controls, a poster and info overlay, an
     up-next playlist, and the playback events needed for progress reporting.
   - `VideoApp.Launch` stays as a fallback if APL Video misbehaves.
6. **Progress sync.**
   - Report progress to Plex through `/:/timeline` (playing/paused/stopped)
     and mark items watched with `/:/scrobble`, so Continue Watching matches
     every other Plex client.
   - Resume from `viewOffset`.

### Main risk to prove first

Two kinds of traffic are involved, and only one of them is on 443:
- **plex.tv on 443** handles sign-in (PIN/JWT) and server discovery
  (`/api/v2/resources`). The skill backend makes these calls; no port issue.
- **Media comes from the server itself.** plex.tv does not proxy video. Like
  Plex Web, which loads from app.plex.tv on 443 and then streams from
  `…plex.direct:32400`, the Echo has to fetch the HLS stream from the
  server's published Remote Access address. That is usually **32400 or a
  custom external port**. Plex Relay is the exception, but it is
  bandwidth-capped, so it isn't viable for video.

Alexa's AudioPlayer requires 443. The video docs only say HTTPS with a
trusted certificate; I couldn't confirm the port rule because the Amazon doc
pages render client-side.

**M0 must confirm that the Echo Show 11 plays HLS from
`https://…plex.direct:32400`.** If it doesn't, the options are:
- (a) a documented, user-side reverse proxy on 443, or
- (b) an optional relay.

Option (b) adds hosting cost and bandwidth.

## Voice and touch design (first draft)

Invocation name: "complexity" (fallback: "complexity player"), confirmed
after testing in M0.

| Say | Does |
|---|---|
| "Alexa, open My Plex" | Home screen: Continue Watching, Recently Added, libraries |
| "…play The Bear" | Next unwatched episode, or resume the in-progress one |
| "…play season 2 episode 3 of The Bear" | That episode |
| "…play the movie Dune" | Movie, resuming if partly watched |
| "…continue watching" / "…what's on deck" | Plex On Deck |
| "…what's new" | Recently added grid |
| "…search for Nolan" | Results grid; tap or say "number two" to pick |
| "Alexa, pause / resume / skip forward 30 seconds / go back 10 seconds / next episode" | APL Video transport plus `AMAZON.*` intents |
| "…turn on subtitles" / "…switch audio to English" | Transcode-session stream selection |
| "…who's in this?" | Cast overlay for the current item |

Touch is first-class on the Show. Every grid tile and control is tappable
(APL `TouchWrapper` → `UserEvent`).

Recognition:
- An `AMAZON.SearchQuery` / `AMAZON.VideoCreativeWork`-style title slot, plus
  server-side fuzzy matching against Plex `/hubs/search`.
- Optional dynamic entities seeded from the user's library on launch.

## Architecture

```
Echo Show 11 ── voice/touch ──▶ Alexa cloud ──▶ Skill backend (Alexa-hosted Lambda, Node)
     ▲                                             │  ├─ DynamoDB: userId → Plex token, server, prefs
     │                                             │  └─ plex.tv: PIN auth, server resources
     │                                             ▼
     └── HLS video (https://…plex.direct:port, transient token) ── user's Plex Media Server
```

The backend never relays video; bandwidth goes directly from the user's server
to their Echo.

## Milestones

**M0 — Spikes on the real Echo Show 11**
1. A dev-stage skill created with the ASK CLI from this repo. Check launch
   and an intent round-trip under Alexa+, and pick the invocation name.
2. APL Video playing (a) a public HLS test stream on 443, (b) an HLS
   transcode from your Plex through `plex.direct:32400` with a transient
   token, and (c) a direct-play MP4 from Plex. Record which formats and
   ports work.
3. The same URLs through `VideoApp.Launch`, for comparison.
4. The Plex PIN flow end-to-end from the skill, with the code shown on the
   screen.

**M1 — Watch something by voice (MVP)**
- Link Plex, auto-pick the server, and choose a server if there are several.
- "Play <movie>", "Play <show>" (next unwatched) and "Continue watching".
- APL player with play/pause, seek and next episode.
- Progress and scrobble reporting; resume from offset.

**M2 — Browse on the screen**
- Home screen hubs (On Deck, Recently Added, per library), search results
  grid, show and season pages, and detail pages with poster, summary,
  rating and cast.

**M3 — Viewing quality**
- Subtitle and audio track selection.
- Quality setting: Original, 1080p or 720p, based on bandwidth.
- Auto-play the next episode with a countdown.
- "Skip intro" using Plex intro markers, which are available to Plex Pass
  servers.

**M4 — Multi-user and sharing**
- Plex Home users: "switch to Kids profile", with managed-user PINs.
- Shared (friend) servers.
- Skill Beta Test invites for up to 500 Amazon accounts.

## Repo layout (planned)

```
skill-package/      skill.json manifest, interaction model, APL documents
lambda/src/
  handlers/         launch, play, browse, transport, APL UserEvent, link
  plex/             plex.tv auth (PIN/JWT), resources, search, transcode URLs, timeline
  apl/              document builders (home, grid, detail, player, link code)
  store/            DynamoDB user records
lambda/test/        unit tests with recorded Plex and Alexa request fixtures
docs/               this plan, setup guide
```

Stack: plain Node.js (CommonJS), `ask-sdk-core` and `node:test`. Alexa-hosted
runs nodejs16.x, so `src/http.js` stands in for fetch, and the store uses the
AWS SDK v2 bundled with that runtime (or v3 where it exists). Alexa-hosted runs `npm install` with no build
step, so there is no TypeScript.

## Security notes

- Lambda endpoints get Alexa request verification from the platform. Still
  pin the skill ID in the handler.
- Store Plex tokens per user (DynamoDB, encrypted at rest), delete them on skill disable
  (`AlexaSkillEvent.SkillDisabled`), and support "unlink Plex" by voice.
- Only transient (48 h) tokens appear in stream URLs.
- Never log tokens or full stream URLs.

## Naming and trademark

"Complexity" is an ordinary word and doesn't use the Plex trademark as a name.
The store description still says "Plex" when describing what the skill works
with, plus a "not affiliated" line, which is the usual nominative use.
Single-word invocation names are allowed in the Development stage, but
certification only accepts them for distinctive brand names. If the skill is
published, "complexity" may have to become two words (for example "complexity
player").

## Prerequisites

- An Amazon Developer account, on the same Amazon account as the Echo Show 11.
- A Plex server with Remote Access enabled (Settings → Remote Access shows
  "Fully accessible outside your network").
- ASK CLI (`npm i -g ask-cli`), configured with your developer account
  (`ask configure`).

## Decisions (2026-10-19)

- **Hosting:** Alexa-hosted. Node.js, Lambda, and the provided DynamoDB table.
- **Repo:** public on GitHub, MIT licence.
- **Audience:** personal use for now. The Plex login path is built for many
  users from the start, keyed per Alexa user, so a later beta needs no rework.

## Status

**Plex login path: done in code, covered by tests, not yet run on the device.**

| Piece | File |
|---|---|
| Per-user device identity: client ID and Ed25519 key | `lambda/src/plex/deviceKey.js` |
| PIN with JWK, poll with deviceJWT, nonce refresh, legacy-token fallback | `lambda/src/plex/auth.js` |
| Server discovery, connection probing; relay never used for streams | `lambda/src/plex/servers.js` |
| Link state machine: unlinked → linking → choose-server / no-server → ready | `lambda/src/link.js` |
| Voice and APL handlers; screen polls every 5 s; voice-only "I entered the code" | `lambda/src/handlers.js`, `lambda/src/apl/link.js` |
| Per-user storage (DynamoDB / memory); delete on unlink and SkillDisabled | `lambda/src/store.js`, `lambda/index.js` |

Tests (`npm test` in `lambda/`) run against a fake plex.tv that verifies
the device JWT signatures.

**JWT sign-in is off for now (2026-10-19).** Plex Media Server 1.42.2 rejects
JWTs (HTTP 401). With a JWT, `/api/v2/resources` also hands back JWT server
tokens, which PMS rejects too. So the PIN is created without a `jwk`, and
plex.tv issues a legacy token, which works with plex.tv and PMS alike. The JWT
code stays in place behind `USE_JWT` in `lambda/src/plex/auth.js`, with tests.
Links made while JWT was on are asked to relink once.

The JWT field names come from the community OpenAPI spec
(LukeHagar/plex-api-spec) and the Plex developer forum, because
developer.plex.tv renders client-side. The refresh `scope` value is a best
guess. If plex.tv returns a legacy token instead of a JWT, everything still
works, because legacy tokens don't expire.

## Open questions

1. Invocation name "complexity": test ASR recognition on the Show in M0 (it may be heard as the plain word and routed to Alexa's general answers).
