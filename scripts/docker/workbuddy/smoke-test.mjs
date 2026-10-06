#!/usr/bin/env node
/**
 * WorkBuddy image smoke test — runs INSIDE the built image.
 *
 * The CI job `docker cp`s this file into the freshly built container and runs
 * `node /smoke-test.mjs` with `docker exec`. Everything therefore talks to
 * 127.0.0.1:20128 *inside* the container, which is also the only way to reach
 * the `/api/workbuddy/*` routes: `src/server/authz/routeGuard.ts` classifies
 * that subtree as LOCAL_ONLY (loopback peer only), and a published port would
 * arrive from the docker bridge instead.
 *
 * What it proves, in the order a real operator hits it:
 *   1. the image boots and serves /api/health;
 *   2. the dashboard login works (management session cookie);
 *   3. the provider-wizard capability probe for BOTH editions resolves —
 *      this is where "Unknown provider: workbuddy" used to come from;
 *   4. adding the provider through the dashboard path (POST …/import-token)
 *      creates a connection instead of erroring;
 *   5. the connection is listed by GET /api/providers;
 *   6. the addon's own routes (/api/workbuddy/*) are compiled into the image.
 *
 * Exit code 0 = every check passed; 1 = at least one failed (the workflow then
 * fails and the image must not be trusted).
 *
 * @module scripts/docker/workbuddy/smoke-test
 */

const BASE = process.env.SMOKE_BASE_URL || "http://127.0.0.1:20128";
const PASSWORD = process.env.SMOKE_PASSWORD || "smoke-test-password";

const EDITIONS = [
  { id: "workbuddy", label: "WorkBuddy (国内版)" },
  { id: "workbuddy-global", label: "WorkBuddy (International)" },
];

let failures = 0;

function check(ok, label, detail = "") {
  const mark = ok ? "✅" : "❌";
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function req(path, { method = "GET", body, cookie, timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await res.text();
    const rawCookie =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    return { status: res.status, text, setCookie: rawCookie };
  } catch (err) {
    return { status: 0, text: String(err && err.message ? err.message : err), setCookie: [] };
  } finally {
    clearTimeout(timer);
  }
}

function sessionCookieOf(setCookie) {
  for (const raw of setCookie) {
    const pair = String(raw).split(";")[0].trim();
    if (pair.startsWith("auth_token=")) return pair;
  }
  return "";
}

const looksUnknownProvider = (t) => /unknown provider/i.test(t);
const looksUnsupported = (t) => /not supported for provider/i.test(t);

async function main() {
  console.log(`WorkBuddy smoke test against ${BASE}\n`);

  // 1) boot
  const health = await req("/api/health");
  check(
    health.status === 200 && /"status"\s*:\s*"ok"/.test(health.text),
    "image boots and /api/health is ok",
    `HTTP ${health.status}`,
  );
  if (health.status !== 200) {
    console.log(health.text.slice(0, 400));
    process.exit(1);
  }

  // 2) dashboard login (management session)
  const login = await req("/api/auth/login", { method: "POST", body: { password: PASSWORD } });
  const cookie = sessionCookieOf(login.setCookie);
  check(login.status === 200 && cookie.length > 0, "dashboard login issues a session", `HTTP ${login.status}`);
  if (login.status !== 200) console.log(login.text.slice(0, 400));

  // 3) capability probe the wizard calls when you click the provider card
  for (const edition of EDITIONS) {
    const probe = await req(
      `/api/oauth/${edition.id}/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback`,
      { cookie },
    );
    const ok = probe.status > 0 && probe.status < 500 && !looksUnknownProvider(probe.text);
    check(ok, `provider wizard resolves ${edition.label}`, `HTTP ${probe.status}`);
    if (!ok) console.log(probe.text.slice(0, 400));
  }

  // 4) add the provider through the dashboard path (paste-a-token import)
  const token = "smoke-test-workbuddy-session-token";
  const add = await req("/api/oauth/workbuddy/import-token", {
    method: "POST",
    body: { token },
    cookie,
  });
  const addOk =
    add.status === 200 && !looksUnknownProvider(add.text) && !looksUnsupported(add.text);
  check(addOk, "adding WorkBuddy creates a connection", `HTTP ${add.status}`);
  if (!addOk) console.log(add.text.slice(0, 500));

  // 5) the connection shows up in the provider list
  const list = await req("/api/providers", { cookie });
  const listed = list.status === 200 && /workbuddy/.test(list.text);
  check(listed, "GET /api/providers lists the WorkBuddy connection", `HTTP ${list.status}`);
  if (!listed) console.log(list.text.slice(0, 500));

  // 6) the addon routes are compiled in (loopback-only, we are inside the box)
  const info = await req("/api/workbuddy/info", { cookie });
  check(info.status !== 404, "WorkBuddy addon routes are registered", `HTTP ${info.status}`);
  if (info.status === 404) console.log(info.text.slice(0, 300));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
