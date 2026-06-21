# Team Board

A **zero-dependency** Node tool that lets a Product Owner (PO) track every unit
of work across **multiple projects** and **multiple features**, and approve (UAT)
what counts as "Done".

The hierarchy is **Project → Epic → Task**. Each task flows through a fixed,
role-aware state machine:

```
backlog → progress → test → uat → done
               (reject → backlog)
```

| Step                | Role        | Notes                                      |
| ------------------- | ----------- | ------------------------------------------ |
| backlog → progress  | engineer    |                                            |
| progress → test     | engineer    |                                            |
| test → uat          | qa          | requires `--tests-pass`                    |
| test → backlog      | qa          | reject                                     |
| uat → done          | **po only** |                                            |
| uat → backlog       | **po only** | reject                                     |

Invalid steps and wrong-role moves are rejected with a clear error.
`lib/workflow.js` is the single source of truth and is never modified.

---

## Architecture

The board runs on **Vercel**. Both the Mac Mini agent team and the PO's browser
talk HTTPS to the same Vercel deployment. Vercel KV (Upstash Redis) is the
single persistent data store — no local file is authoritative after the cloud
migration.

```
Mac Mini (agent team)   ──HTTPS── board.js remote mode ──►  Vercel API ──►  Vercel KV
PO (browser anywhere)   ──HTTPS── Vercel static UI     ──►  Vercel API ──►  Vercel KV
```

**Key design choices:**

- The board is password-protected. Every visitor must enter `BOARD_PASSWORD`
  before seeing any data.
- Login issues an **HMAC-signed HttpOnly session cookie** (signed with
  `BOARD_SECRET`). All API endpoints verify this cookie; missing or invalid
  cookies receive HTTP 401 and no board data.
- Concurrent agent moves use an **atomic Lua EVAL CAS** inside Vercel KV so no
  update is ever silently lost.
- The browser polls `/api/board` every 30 seconds and has a manual refresh
  button. SSE is out of scope per spec.
- `lib/workflow.js` is unchanged — all role and transition rules are identical
  to the local-file version.

---

## Environment Variables

These four variables are **required** for the cloud deployment. **Never commit
them to the repository** (see CLAUDE.md).

| Variable            | Where to set                                  | What it is                                                                                       |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `KV_REST_API_URL`   | Vercel project settings + seed machine        | REST endpoint URL for your Vercel KV (Upstash) database. Injected automatically when you link KV in the Vercel dashboard. |
| `KV_REST_API_TOKEN` | Vercel project settings + seed machine        | Auth token for the Vercel KV REST API. Also auto-injected when KV is linked.                    |
| `BOARD_PASSWORD`    | Vercel project settings + Mac Mini shell/env  | Shared password that protects view **and** edit access to the board.                            |
| `BOARD_SECRET`      | Vercel project settings only                  | Secret used to HMAC-sign session cookies. Use a long random value — see generation command below. |

Generate a strong `BOARD_SECRET`:

```sh
openssl rand -hex 32
```

---

## Deploy to Vercel (manual steps for the PO)

This repository does **not** automatically deploy to Vercel. The PO performs
these steps once.

### a. Create the Vercel project and connect the repo

1. In the [Vercel dashboard](https://vercel.com/), click **Add New > Project**.
2. Import this Git repository.
3. **Set the Root Directory to `testgent`** — the parent directory of this
   repo is the outer workspace; the actual app lives in `testgent/`.
4. Leave the framework preset as **Other** (no build step needed).
5. Click **Deploy** — Vercel will detect `vercel.json` and configure routes
   automatically.

### b. Provision Vercel KV (Upstash Redis)

1. Inside your Vercel project, go to **Storage > Connect Store > KV**.
2. Create a new KV database (or attach an existing one).
3. Vercel will automatically inject `KV_REST_API_URL` and `KV_REST_API_TOKEN`
   as environment variables. You can verify this under **Settings > Environment
   Variables**.

### c. Set BOARD_PASSWORD and BOARD_SECRET

In the Vercel project: **Settings > Environment Variables**, add:

| Name            | Value                                            |
| --------------- | ------------------------------------------------ |
| `BOARD_PASSWORD` | Your chosen board password                      |
| `BOARD_SECRET`   | Output of `openssl rand -hex 32` (keep private) |

Apply to **Production** (and Preview / Development if desired).

### d. Seed KV once

The seed script loads `board-data.json` from disk and writes it into KV. Run it
**once** from a machine that has the KV credentials (e.g. your laptop with the
Vercel env vars exported, or inside a Vercel CLI pull).

```sh
# From the testgent/ directory:
KV_REST_API_URL=<your-url> KV_REST_API_TOKEN=<your-token> npm run seed

# Or equivalently:
KV_REST_API_URL=<your-url> KV_REST_API_TOKEN=<your-token> node scripts/seed-kv.js
```

> **WARNING — OVERWRITE:** The seed script unconditionally overwrites the
> `board` key in KV with the contents of `board-data.json`. Re-running it
> **discards all live changes** that have accumulated in KV since the last seed.
> Run it only once during initial deployment, or intentionally when you need to
> reset the board to the seed file.

### e. Open the board

Push to the connected branch (or trigger a Vercel deploy). Open the Vercel
deployment URL in a browser — you will see the login screen. Enter
`BOARD_PASSWORD` to access the board.

---

## Point Mac Agents at the Cloud (remote mode)

`board.js` detects a remote configuration and POSTs to the Vercel API instead
of writing a local file. **Only the `move` command supports remote mode**; all
other commands (`list`, `show`, `add-task`, etc.) still use the local
`board-data.json`.

### Using environment variables (recommended for the Mac Mini)

Export these in the shell or in the agent's environment:

```sh
export BOARD_REMOTE=https://your-project.vercel.app
export BOARD_PASSWORD=your-board-password
```

Then run moves normally:

```sh
node board.js move <task-id> <status> --by <engineer|qa|po> [--tests-pass]

# Examples:
node board.js move EP-1-T1 progress --by engineer
node board.js move EP-1-T1 test     --by engineer
node board.js move EP-1-T1 uat      --by qa --tests-pass
node board.js move EP-1-T1 done     --by po
```

### Using CLI flags (one-off / override)

```sh
node board.js move EP-1-T1 uat --by qa --tests-pass \
  --remote https://your-project.vercel.app \
  --password your-board-password
```

CLI flags take precedence over environment variables.

### What happens under the hood

1. `board.js` calls `POST /api/login` with `{ password }` → receives an
   HMAC-signed session cookie.
2. It calls `POST /api/move` with the session cookie and `{ id, to, by,
   testsPass }` → Vercel applies the state-machine rule and persists to KV.
3. On success the CLI prints `✓ <id>: → <status> (by <role>) [remote]` and
   exits 0. On failure it prints the error and exits non-zero.

**Without remote config** (no `BOARD_REMOTE` / `BOARD_PASSWORD` and no CLI
flags), `board.js` falls back to the original local file mode and writes
`board-data.json` directly — useful for local dev and tests.

---

## Auth / Security Model

- **One shared password** (`BOARD_PASSWORD`) protects view and edit.
- `POST /api/login { password }` — if the password matches, the server signs a
  token `{ board: true, iat, exp }` with HMAC-SHA256 keyed on `BOARD_SECRET`
  and sets a `board_token` **HttpOnly, Secure, SameSite=Lax** cookie with an
  8-hour TTL.
- `GET /api/board` and `POST /api/move` both verify the cookie on every
  request. An absent, tampered, or expired cookie receives **HTTP 401** and
  **no board data is leaked**.
- The HMAC signing uses Node's built-in `crypto` module — zero runtime
  dependencies.
- All API responses carry `Cache-Control: no-store` to prevent proxies from
  caching board data.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`,
  `X-XSS-Protection`) are set on every response via `vercel.json`.

---

## Local Development and Testing

The full test suite runs **offline** — KV is mocked and no cloud credentials
are needed.

```sh
npm test
# node --test test/*.test.js
```

Requires **Node >= 18** (uses the built-in test runner and `globalThis.fetch`).
All 317 tests must pass before merging.

`npm start` runs the legacy local HTTP server (`server.js`) on port 3000,
serving the board from `board-data.json` on disk. This is useful for UI
development but does **not** use Vercel KV — it is the pre-migration local
mode.

```sh
npm start              # http://localhost:3000
```

There is currently no separate `lint` script; the automated gate is the test
suite (`npm test`).

---

## Agents' CLI Reference

```sh
node board.js move <task-id> <status> --by <engineer|qa|po> [--tests-pass]
                   [--remote <url> --password <pw>]   # remote mode
node board.js list  [--project <id>] [--epic <id>] [--status <s>]
node board.js show  <task-id>
node board.js add-task    --project <id> --epic <id> --title "..." [--agent ..] [--deps "a,b"]
node board.js create-epic --project <id> --id <EP-x> --title "..." [--spec path]
node board.js init
```

Add `--file <path>` to point at a different `board-data.json` (default
`./board-data.json`). You can also run commands via `npm run board -- ...`.

---

## What This Build Does NOT Do (PO Must Do Manually)

This build delivers the code and documentation. The following steps require
real cloud credentials and must be performed by the PO:

- **Create and deploy the Vercel project** — link the repository and configure
  the Root Directory.
- **Provision Vercel KV** — create the Upstash Redis database and link it to
  the project.
- **Set the four environment variables** — `KV_REST_API_URL`,
  `KV_REST_API_TOKEN`, `BOARD_PASSWORD`, and `BOARD_SECRET` in Vercel project
  settings.
- **Connect the Git repository** to trigger Vercel deployments on push.
- **Run the one-time seed** — `npm run seed` (with KV creds exported) to
  populate KV from `board-data.json` before the board is usable.

None of these steps are automated by CI/CD. After the PO completes them,
subsequent code changes deploy automatically when pushed to the connected
branch.

---

## CI

`.github/workflows/ci.yml` runs `npm test` on Node 18 and 20 for every push
and pull request. A red suite blocks merge.
