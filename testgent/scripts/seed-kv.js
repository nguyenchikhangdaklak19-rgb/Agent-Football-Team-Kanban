/*
 * scripts/seed-kv.js — one-time seed script
 *
 * Loads board-data.json from disk and writes it into Vercel KV via
 * lib/kv-store.save().
 *
 * OVERWRITE WARNING:
 *   This script unconditionally OVERWRITES the "board" key in KV.
 *   Run it only once during initial deployment, or deliberately when you
 *   need to reset KV state back to the seed file contents.
 *   After the initial seed, KV is the single source of truth — re-running
 *   this script DISCARDS any changes that have accumulated in KV.
 *
 * Usage:
 *   KV_REST_API_URL=<url> KV_REST_API_TOKEN=<token> node scripts/seed-kv.js
 *   OR:
 *   npm run seed     (with env vars exported in the shell)
 *
 * The seed function is exported so tests can inject a mock KV client
 * and a custom data source without touching the network.
 *
 * No new runtime dependencies are added: lib/kv-store.js uses Node 18+
 * globalThis.fetch, which is built in. This script is zero-dep.
 */
"use strict";

const path = require("path");
const fs   = require("fs");

const { save } = require("../lib/kv-store");

/**
 * seedKv({ data, kvOpts })
 *
 * Core seeding logic — injectable for testing.
 *
 * @param {object} opts
 * @param {object}  opts.data    - Board object to write (already parsed).
 *                                 Pass this to avoid touching the filesystem in tests.
 * @param {string} [opts.dataPath] - Path to a JSON file to read board data from.
 *                                   Ignored when opts.data is supplied.
 * @param {object} [opts.kvOpts]   - Options forwarded verbatim to kv-store.save()
 *                                   (e.g. { client: mockClient } for offline tests,
 *                                   or {} to fall back to KV_REST_API_URL / KV_REST_API_TOKEN).
 *
 * @returns {Promise<object>} Resolves with the board object that was written.
 */
async function seedKv(opts) {
  opts = opts || {};

  let board;
  if (opts.data !== undefined) {
    board = opts.data;
  } else {
    const filePath = opts.dataPath || path.resolve(__dirname, "../board-data.json");
    const raw = fs.readFileSync(filePath, "utf8");
    board = JSON.parse(raw);
  }

  await save(board, opts.kvOpts || {});
  return board;
}

module.exports = { seedKv };

// ---------------------------------------------------------------------------
// CLI entry point — only runs when this file is executed directly.
// ---------------------------------------------------------------------------
if (require.main === module) {
  seedKv()
    .then((board) => {
      const projectCount = Array.isArray(board.projects) ? board.projects.length : 0;
      console.log("[seed] SUCCESS: board written to KV.");
      console.log("[seed] Projects seeded:", projectCount);
      console.log(
        "[seed] WARNING: This OVERWRITES the 'board' key in KV.",
        "Re-running resets KV to the seed file contents and discards any live changes."
      );
    })
    .catch((err) => {
      console.error("[seed] FAILED:", err.message);
      process.exit(1);
    });
}
