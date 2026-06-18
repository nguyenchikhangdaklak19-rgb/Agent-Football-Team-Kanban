# Team Board

A small, **zero-dependency** Node tool that lets a **Product Owner (PO) who does
not read code** track every unit of work across **multiple projects** and
**multiple features**, and approve (UAT) what counts as "Done".

The hierarchy is **Project → Epic → Task**. Each task flows through a fixed,
role-aware state machine:

```
backlog → progress → test → uat → done
              (reject → backlog)
```

| Step              | Role       | Notes                                 |
| ----------------- | ---------- | ------------------------------------- |
| backlog → progress| engineer   |                                       |
| progress → test   | engineer   |                                       |
| test → uat        | qa         | requires tests to pass (`--tests-pass`) |
| test → backlog    | qa         | reject                                |
| uat → done        | **po only**|                                       |
| uat → backlog     | **po only**| reject                                |

Invalid steps and wrong-role moves are rejected with a clear error — the state
machine (`lib/workflow.js`) is the single source of truth. Only the **PO** can
push `uat → done` or `uat → backlog`.

## Run

```sh
npm start              # node server.js
```

Then open <http://localhost:3000>.

Configuration comes from the environment (never committed):

| Env var      | Default              | Meaning                              |
| ------------ | -------------------- | ------------------------------------ |
| `PORT`       | `3000`               | HTTP listening port                  |
| `BOARD_FILE` | `./board-data.json`  | Path to the board data file (resolved relative to the project dir when not absolute) |

Example:

```sh
PORT=8080 BOARD_FILE=/var/lib/team-board/board-data.json npm start
```

The server logs the listening URL on boot, serves the PO web UI, and pushes
near-real-time updates via Server-Sent Events whenever `board-data.json`
changes. PO Approve / Reject buttons appear on cards sitting in the UAT column.

## Agents' CLI

Agents update task state from the command line — **never by hand-editing
`board-data.json`**. The CLI enforces the same state machine and writes history.

```sh
node board.js move <task-id> <status> --by <engineer|qa|po> [--tests-pass]
node board.js list  [--project <id>] [--epic <id>] [--status <s>]
node board.js show  <task-id>
node board.js add-task    --project <id> --epic <id> --title "..." [--agent ..] [--deps "a,b"]
node board.js create-epic --project <id> --id <EP-x> --title "..." [--spec path]
node board.js init
```

Add `--file <path>` to point at a different `board-data.json` (default
`./board-data.json`). You can also run it via `npm run board -- ...`.

Examples:

```sh
node board.js move EP-1-T1 progress --by engineer
node board.js move EP-1-T1 test     --by engineer
node board.js move EP-1-T1 uat      --by qa --tests-pass
node board.js move EP-1-T1 done     --by po          # PO only
```

## Tests

```sh
npm test               # node --test "test/**/*.test.js"
```

Uses the built-in Node test runner (requires **Node >= 18**); no dependencies.

## Run 24/7 on the Mac Mini

The board is meant to stay up continuously. The recommended approach on macOS is
a **launchd user agent**.

Create `~/Library/LaunchAgents/com.team.board.plist` (adjust the paths — the
`node` path comes from `which node`, e.g. `/opt/homebrew/bin/node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.team.board</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/khang/mfa-E1/testgent</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>3000</string>
        <key>BOARD_FILE</key>
        <string>/Users/khang/mfa-E1/testgent/board-data.json</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/khang/Library/Logs/team-board.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/khang/Library/Logs/team-board.err.log</string>
</dict>
</plist>
```

Load it (it starts immediately because `RunAtLoad=true`, and `KeepAlive=true`
restarts it if it ever exits):

```sh
launchctl load ~/Library/LaunchAgents/com.team.board.plist
```

To stop / reload after editing the plist:

```sh
launchctl unload ~/Library/LaunchAgents/com.team.board.plist
launchctl load   ~/Library/LaunchAgents/com.team.board.plist
```

**One-line alternative with pm2:**

```sh
pm2 start server.js --name team-board && pm2 save && pm2 startup
```

## Data

State lives in **`board-data.json`** (schema: `workflow` + `projects → epics →
tasks → history`). The `workflow` block defines the state machine.

**Never hand-edit `board-data.json`.** All status changes must go through the
board CLI (`node board.js move ...`) or the PO Approve / Reject buttons in the
web UI. The state machine enforces valid steps and roles and records full
per-task history for traceability.
