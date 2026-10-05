# Omniroute-Workbuddy (lightweight delta repo)

This repo does **not** carry the OmniRoute source tree. The author's releases
already ship the full compiled server, so this branch contains **only the
WorkBuddy delta** and stays lightweight:

```
├── .github/workflows/workbuddy-sync-build.yml  sync-upstream + docker build CI
├── Dockerfile.workbuddy                         image build (no recompile)
├── scripts/docker/workbuddy/
│   ├── take-upstream.sh     pulls the author's compiled omniroute@<latest>
│   ├── apply.mjs            layers the WorkBuddy delta on top (converge mode)
│   └── prune-package.sh     strips electron/docs/tests from the package
└── workbuddy-overlay/
    ├── README.md            how the delta is structured
    ├── files/               WorkBuddy-only compiled artifacts (fill once locally)
    └── rewrites.json        anchored patches into upstream compiled files
```

Every upstream release (`diegosouzapw/OmniRoute`, e.g. v3.8.51) is picked up
automatically by the cron workflow and re-published as
`ghcr.io/yakuza8702/omniroute-workbuddy:{<upstream-version>, latest}` with the
WorkBuddy changes re-applied on top — nothing to rebuild, the git stays light.

To rebuild the CI scaffolding against the upstream tree, the scripts expect this
branch's layout and only need the delta files above.
