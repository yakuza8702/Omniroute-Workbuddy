# WorkBuddy overlay — the "changed from my side" layer

```
workbuddy-overlay/
├── files/            verbatim copies over the upstream package
│                       - dist/… compiled WorkBuddy addon artifacts
│                         (produced locally once: scripts/docker/workbuddy/apply.mjs reads it)
│                       - src/lib/workbuddy/**  (addon runtime sources)
│                       - src/app/api/workbuddy/** (addon API routes)
│                       - open-sse/executors/workbuddy*.ts (executors)
│                       - src/i18n/messages/*.json workbuddy keys
├── rewrites.json     surgical anchored text patches INTO upstream compiled files
│                       (registry, token refresh dispatch, usage dispatch… wiring)
└── README.md         this file
```

Default mode is converge-not-fail: a drifted anchor is **reported and skipped**,
the build still publishes the newest upstream version. `WORKBUDDY_STRICT=1`
(container/CI override) makes it exit 2 and refuse to continue.


## How it flows

1. `scripts/docker/workbuddy/take-upstream.sh <version>` — pull the *latest*
   upstream release package and extract it to `build/workbuddy/upstream/`.
2. `scripts/docker/workbuddy/apply.mjs` — copy `files/**` over the extracted
   package and apply the `rewrites.json` anchors. Fails **loudly** (exit 2) if
   an anchor no longer matches, meaning the upstream output changed under us.
3. `Dockerfile.workbuddy` — install prod deps and publish the image tagged
   `:latest` and `:<upstream-version>` to `ghcr.io/yakuza8702/omniroute-workbuddy`.

## When the author ships a new release

The scheduled workflow (`.github/workflows/workbuddy-sync-build.yml`, cron
`0 3,15 * * *`) detects the newer version, re-extracts the upstream artifact and
re-applies this overlay on top — the WorkBuddy changes always survive.

If an anchor has drifted (reported in `build/workbuddy/APPLY_MANIFEST.json`):
regenerate the affected compiled file(s) once locally, verify the anchor still
matches, and update `rewrites.json`. Verbatim-overlay files (`files/**`) keep
applying untouched.

