---
title: "WorkBuddy Addon (国内版 + International)"
version: 3.8.52
lastUpdated: 2026-10-04
---

# WorkBuddy Addon (国内版 + International)

The **WorkBuddy addon** connects the [WorkBuddy](https://www.workbuddy.ai) desktop app's two
editions to OmniRoute as ordinary providers, and adds the account surfaces a plain gateway
integration cannot show: **credit balance**, **credit claim (daily check-in)**, **the current
free model**, and a machine-readable description of how the addon itself works.

WorkBuddy is not sold as bare API keys — the account lives in the desktop app — so the addon's
first job is to integrate that application. It does so **read-only**.

```
WorkBuddy desktop app  ──(read-only auth files)──▶  POST /api/workbuddy/import
                                                          │
                                                          ▼
                                        provider connection (workbuddy | workbuddy-global)
                                                          │
      ┌───────────────────────────────────────────────────┼────────────────────────────────┐
      ▼                                                   ▼                                ▼
GET /api/workbuddy/models                        GET /api/workbuddy/credits      GET|POST /api/workbuddy/checkin
(edition model directory)                        (billing: get-user-resource)    (status → claim)
```

## Editions are separate providers

| Provider id        | Alias | Edition       | Chat / billing gateway                                     | Model directory                   | Check-in |
| ------------------ | ----- | ------------- | ---------------------------------------------------------- | --------------------------------- | -------- |
| `workbuddy`        | `wb`  | 国内版        | `https://copilot.tencent.com` / `https://www.codebuddy.cn` | `/v2/enterprises/personal/models` | yes      |
| `workbuddy-global` | `wbg` | International | `https://www.workbuddy.ai` (or `https://www.codebuddy.ai`) | `/v3/config`                      | no       |

They are **never merged**: an account signed in on one gateway is rejected by the other, their
model rosters differ, and only the domestic edition has a daily check-in. The international
edition is reachable under two brand domains — the desktop app signs in at `workbuddy.ai`, the
CodeBuddy CLI at `codebuddy.ai` — and because a token minted at one is refused by the other, the
gateway always follows the credential's own login domain.

## Quick start

1. Open the WorkBuddy desktop app and sign in (either edition). Both are detected automatically.
2. `GET /api/workbuddy/accounts` — lists the accounts the app has left on this machine, as
   **fingerprints** plus masked labels. Nothing else leaves the server.
3. `POST /api/workbuddy/import` with `{"fingerprint": "…"}` — imports that account. The server
   re-reads the auth files and stores the session on the matching provider connection.
4. Sync models: `POST /api/providers/<connectionId>/sync-models`. The WorkBuddy addon answers it
   from the edition's own directory and keeps each model's credit rate as `isFree`.
5. Chat through `workbuddy` / `workbuddy-global` like any other provider.

If the account's auth file has **encrypted** token fields (recent Windows builds store
`{"$wbEncrypted":1,"envelope":"…"}`), the addon reports that condition — with the app-executable
hint — instead of pretending the machine is signed out, and you can paste a token into the
provider form instead.

## Multiple accounts

A machine usually has more than one WorkBuddy sign-in: the desktop app keeps a **timestamped
backup auth file per login**, and the two editions can be signed in at the same time. Each
import becomes its **own provider connection**, which is what lets the platform do what it
already does for every other provider — priority ordering, rotation and failover between them —
instead of the addon keeping a second account list.

- Discovery reports **one entry per account**, de-duplicated by login domain + account id, so the
  live sign-in and its backup copy are not counted twice; each entry carries a fingerprint.
- Importing an account that is already imported **updates** that connection in place (same domain
  - account id), so a rotated desktop session never leaves a stale second row behind.
- Routing across those connections is the platform's: order them by priority in the dashboard, or
  let the router rotate and fail over as it does for any provider.

The addon's **overview** routes (credits, check-in, free model, models) answer for **one account at
a time**, and they say which one via `connectionId` in the response:

| Goal                             | Call                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Use the platform's preferred one | `GET /api/workbuddy/credits` — first _enabled_ connection in the router's order (`priority ASC`, then most recently updated) |
| Target a specific account        | `GET /api/workbuddy/credits?connectionId=<id>`                                                                               |
| Claim one account's daily credit | `POST /api/workbuddy/checkin` `{"connectionId":"<id>"}`                                                                      |
| List every imported account      | `GET /api/workbuddy/accounts` (per edition, with ids and the enabled flag)                                                   |

A `connectionId` that does not name a WorkBuddy connection is a `404 connection_not_found`, never a
silent fallback to another account — claiming the wrong account's credit is exactly the mistake
that prevents. `provider` and `connectionId` may be combined; when they disagree the named
connection's own edition wins, because naming an account has already answered what the filter asks.

Claiming for several accounts means calling `POST /api/workbuddy/checkin` once per `connectionId`.
There is no "claim all" endpoint, deliberately: every call grants real credits, and a batch would
spend them for accounts the caller may not have meant.

## The four WorkBuddy-specific surfaces

### Credit balance — `GET /api/workbuddy/credits`

WorkBuddy meters in **credits**, not tokens, and each model has a rate (`x0.79 credits`). The
addon reads the billing endpoint and returns every package unmerged:

- **refill** packages (recurring; their cycle end is a _refresh_, not an expiry), and
- **one-off** packages (their remaining balance is authoritative; spent or expired ones drop out),

plus `total`, `expiringSoon` (within 72h) and the nearest expiry. The same data feeds the
Provider Limits page through the registered usage fetcher, where the credit count is reported as
the quota's `remaining` value.

### Credit claim — `GET|POST /api/workbuddy/checkin`

`GET` reports today's state (active, already claimed, streak, reward, upstream button caption).
`POST` claims it — after reading the status first, so an already-claimed day is reported rather
than re-posted.

There is **no automatic check-in** and no scheduler: a claim runs only when a caller asks, because
it grants real credits. The international edition has no check-in endpoint, so the addon reports
`checkin_unsupported` there rather than offering an action that always fails.

### Current free model — `GET /api/workbuddy/free-model`

Derived from the live catalogue's own rates: a model is free only when the upstream declares
`x0.00`. A missing rate is **not** free — the addon never guesses. When several zero-rate models
exist, the one with the largest context window is recommended, matching the reference
integration's tie-break.

### How the addon works — `GET /api/workbuddy/info`

Returns the addon's description as data: editions and gateways, every capability with the
upstream endpoints behind it, credential sources and their environment overrides, the guarantees
the addon holds itself to, and the things it deliberately does not do. A UI can render its
feature set from this without hardcoding a second copy of the truth.

## Credential sources

| Platform | Auth directory                                                                 |
| -------- | ------------------------------------------------------------------------------ |
| macOS    | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth`            |
| Windows  | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` (and `%APPDATA%`)         |
| Linux    | `$XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth` (default `~/.config/…`) |

The live file is `workbuddy-desktop.info`; the app also leaves **timestamped backups**
(`workbuddy-desktop.<stamp>.info`) which can belong to different accounts, so the whole directory
is scanned, the live sign-in is listed first, and duplicates are collapsed by account.

Environment overrides: `WORKBUDDY_AUTH_FILE` (one explicit file), `WORKBUDDY_AUTH_DIR` (a
non-default directory), `WORKBUDDY_APP_EXECUTABLE` (reported in diagnostics when fields are
encrypted).

## Chat behaviour

- **Streaming is forced.** The gateway family rejects non-stream chat; OmniRoute re-aggregates
  the SSE for clients that asked for JSON (`forceStream` on the registry entry).
- **A leading system message is guaranteed.** The international gateway refuses a user-first body
  with business code 11128 ("first message is not system prompt"), which surfaces as "blocked by
  security policy"; the domestic gateway tolerates it. The executor inserts a minimal placeholder
  rather than inventing a persona.
- **Per-account identity headers.** `X-User-Id` / `X-Enterprise-Id` / `X-Domain` come from the
  connection; an absent attribute is sent in the gateway's own `X-No-*` spelling, which is a
  different answer to this gateway than an empty value.
- **Session refresh.** `POST /v2/plugin/auth/token/refresh` with the refresh token in the
  `X-Refresh-Token` header, registered for both editions so an expired import heals without a
  re-import.

## Security posture

- Every `/api/workbuddy/*` route is **loopback-only** (`LOCAL_ONLY_API_PREFIXES`) in addition to
  management auth: these routes read this machine's sign-ins and one of them grants credits.
- The desktop app's files are opened **read-only**; the addon never refreshes or rewrites them.
- Tokens never reach a browser: discovery exchanges a `sha256` fingerprint, and the import route
  re-reads the files, so a tampered request can only ask for an account that genuinely exists.
- The account number is masked in listings, and the phone number in the auth file is never read.
- Credit queries are read-only and free; failures are reported with sanitized messages and never
  echo an upstream response body.

## Using the addon from a client (including DeepSeek Harness)

Nothing extra is needed for **routing**: the two editions are ordinary OpenAI-compatible
providers, so any client pointed at OmniRoute's `/v1` endpoint can select their models once an
account is imported and the catalogue synced. That half behaves exactly like every other gateway
integration in OmniRoute.

The account surfaces are plain HTTP, so a harness-side UI or plugin can offer them without
reimplementing any WorkBuddy logic:

| Action               | Call                                                     |
| -------------------- | -------------------------------------------------------- |
| Which accounts exist | `GET /api/workbuddy/accounts`                            |
| Import one           | `POST /api/workbuddy/import` `{"fingerprint":"…"}`       |
| Model list + rates   | `GET /api/workbuddy/models`                              |
| Credit balance       | `GET /api/workbuddy/credits`                             |
| Current free model   | `GET /api/workbuddy/free-model`                          |
| Check-in state       | `GET /api/workbuddy/checkin`                             |
| Claim today's credit | `POST /api/workbuddy/checkin` `{"provider":"workbuddy"}` |
| How the addon works  | `GET /api/workbuddy/info`                                |

All of them are loopback-only and management-authenticated, so a client running on the same
machine is the intended caller.

## Source map

| Concern                    | File                                                    |
| -------------------------- | ------------------------------------------------------- |
| Editions, gateways, paths  | `src/lib/workbuddy/types.ts`                            |
| Upstream client + parsers  | `src/lib/workbuddy/upstream.ts`                         |
| Desktop credential reading | `src/lib/workbuddy/credentials.ts`                      |
| Connections                | `src/lib/workbuddy/accounts.ts`                         |
| Free-model selection       | `src/lib/workbuddy/freeModel.ts`                        |
| Self-description           | `src/lib/workbuddy/addonInfo.ts`                        |
| Sync adapter               | `src/lib/workbuddy/modelDiscovery.ts`                   |
| Executor                   | `open-sse/executors/workbuddy.ts`                       |
| Credit fetcher             | `open-sse/services/usage/workbuddy.ts`                  |
| Token refresh              | `open-sse/services/tokenRefresh/providers/workbuddy.ts` |
| API routes                 | `src/app/api/workbuddy/**`                              |
