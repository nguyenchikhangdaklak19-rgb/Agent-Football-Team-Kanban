/*
 * store — safe load/save of board-data.json.
 *
 * Reusable, race-safe data layer extracted from board.js. The CLI agents and
 * the server may both write this file at runtime, so save() is atomic: it
 * writes a temp file in the same directory then renames over the target
 * (atomic on the same filesystem) to avoid corruption / lost updates.
 *
 * This is a library: no console output, no process.exit. Callers decide how
 * to handle errors.
 */
const fs = require("fs");

function load(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error("store.load: cannot read " + file + ": " + err.message);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error("store.load: invalid JSON in " + file + ": " + err.message);
  }
}

function save(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function findTask(data, id) {
  for (const p of data.projects)
    for (const e of p.epics)
      for (const t of e.tasks)
        if (t.id === id) return { project: p, epic: e, task: t };
  return null;
}

module.exports = { load, save, findTask };
