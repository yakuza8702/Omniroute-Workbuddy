# WorkBuddy overlay — the "changed from my side" layer

```
workbuddy-overlay/
├── files/          verbatim copies over the upstream package (fill once locally)
└── rewrites.json   anchored text patches INTO upstream compiled files
```

rewrites.json is currently EMPTY on purpose: injecting identifiers that don't
exist in the author's compiled output breaks the Next chunk loader
(`Unexpected token '-'` → dashboard pages 500). To wire WorkBuddy properly:

1. Build the real WorkBuddy artifacts locally once (`npm ci && npm run build`)
2. Copy the compiled `dist/.../*.js` chunks + `src/lib/workbuddy/**`,
   `src/app/api/workbuddy/**`, executors, i18n keys into `files/`
3. Derive `rewrites.json` anchors from THE SAME built files so every
   identifier you inject also has a definition in the injected chunks.

When the author releases a new version, the workflow re-extracts + re-applies
this overlay; missing/changed anchors are reported in APPLY_MANIFEST.json.
