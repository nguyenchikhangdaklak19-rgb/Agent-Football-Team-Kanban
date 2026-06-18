/*
 * board-client.js — live client for the Team Board.
 *
 * Drives the static shell in index.html (element IDs: tabs, pending, prog-label,
 * prog-bar, epics, board) from the live API instead of hardcoded data:
 *   - GET  /api/board   -> { workflow, projects }   (source of truth)
 *   - POST /api/move    -> PO Duyệt/Trả lại actions
 *   - GET  /api/stream  -> SSE; on `update` re-fetch + re-render
 *
 * Reproduces the reference mock (team-board.html): same COLUMNS, STATE_CLASS,
 * card structure and CSS classnames so board.css applies unchanged. The only
 * difference is the data is live: agent codes are `tl`/`engineer`/`qa`, tasks
 * carry `deps` (array) + `depMet` + `reject`, and approve/reject hit the API.
 *
 * Vanilla JS, no deps, no build.
 */
(function () {
  "use strict";

  // agent code -> label + colour token. Live data uses engineer/qa (the mock
  // used eng); we map both so either dataset renders.
  var AGENTS = {
    tl: { name: "Tech Lead", color: "var(--ag-tl)" },
    engineer: { name: "Engineer", color: "var(--ag-eng)" },
    eng: { name: "Engineer", color: "var(--ag-eng)" },
    qa: { name: "Reviewer", color: "var(--ag-qa)" },
  };

  var COLUMNS = [
    { key: "backlog", title: "Chờ làm", tick: "var(--txt-hint)" },
    { key: "progress", title: "Đang làm", tick: "var(--interactive)" },
    { key: "test", title: "Đang test", tick: "var(--cyan)" },
    { key: "uat", title: "UAT", tick: "var(--pink)", note: true },
    { key: "done", title: "Xong", tick: "var(--success)" },
  ];

  var STATE_CLASS = { progress: "is-progress", test: "is-test", uat: "is-uat", done: "is-done" };

  // --- state -----------------------------------------------------------------
  // Selected project id + epic id ("all" = aggregate). Preserved across SSE
  // re-renders; reset epic to "all" only when the project changes.
  var DATA = { projects: [] };
  var state = { proj: null, epic: "all" };

  var $ = function (id) { return document.getElementById(id); };

  function getProject() {
    var projects = DATA.projects || [];
    var p = projects.find(function (x) { return x.id === state.proj; });
    return p || projects[0] || null;
  }

  // Flatten the selected project's tasks into {t, ep} rows.
  function projectTasks() {
    var out = [];
    var p = getProject();
    if (!p) return out;
    (p.epics || []).forEach(function (ep) {
      (ep.tasks || []).forEach(function (t) { out.push({ t: t, ep: ep }); });
    });
    return out;
  }

  function prog(list) {
    var tot = list.length;
    var d = list.filter(function (t) { return t.status === "done"; }).length;
    return { d: d, tot: tot, pct: tot ? Math.round((d / tot) * 100) : 0 };
  }

  function allTasks() {
    var p = getProject();
    if (!p) return [];
    return (p.epics || []).reduce(function (acc, e) { return acc.concat(e.tasks || []); }, []);
  }

  // dep tag helper — live data uses `deps` (array); also tolerate a `dep` string.
  function depList(t) {
    if (Array.isArray(t.deps)) return t.deps;
    if (t.dep) return [t.dep];
    return [];
  }

  // --- API -------------------------------------------------------------------
  function fetchBoard() {
    return fetch("/api/board", { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("GET /api/board " + r.status);
        return r.json();
      });
  }

  function postMove(payload) {
    return fetch("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; });
    });
  }

  // --- PO actions ------------------------------------------------------------
  function poAction(id, to, btn) {
    if (btn) btn.disabled = true;
    postMove({ id: id, to: to, by: "po" })
      .then(function (res) {
        if (res && res.ok) {
          // Refresh immediately; the SSE `update` will also fire (idempotent).
          load();
        } else {
          surfaceError((res && res.error) || "Không thực hiện được", btn);
          if (btn) btn.disabled = false;
        }
      })
      .catch(function (e) {
        surfaceError(String(e && e.message ? e.message : e), btn);
        if (btn) btn.disabled = false;
      });
  }

  // Show a small inline error next to the card (no optimistic state change).
  function surfaceError(msg, btn) {
    var card = btn && btn.closest ? btn.closest(".card") : null;
    if (!card) { alert(msg); return; }
    var prev = card.querySelector(".cli-err");
    if (prev) prev.remove();
    var el = document.createElement("div");
    el.className = "cli-err";
    el.setAttribute("role", "alert");
    el.style.cssText =
      "margin-top:8px;font-size:11.5px;font-weight:600;color:var(--error);" +
      "background:rgba(245,34,45,.08);border:1px solid var(--error-sec);" +
      "border-radius:8px;padding:6px 9px;line-height:1.4";
    el.textContent = "⚠ " + msg;
    card.appendChild(el);
  }

  // --- render ----------------------------------------------------------------
  function renderTabs() {
    var box = $("tabs");
    box.innerHTML = "";
    (DATA.projects || []).forEach(function (p) {
      var b = document.createElement("button");
      b.className = "tab" + (p.id === state.proj ? " active" : "");
      b.textContent = p.name;
      b.onclick = function () {
        if (state.proj === p.id) return;
        state.proj = p.id;
        state.epic = "all";
        renderAll();
      };
      box.appendChild(b);
    });
  }

  function epicChip(key, title, eid, p, active) {
    var b = document.createElement("button");
    b.className = "epic-chip" + (active ? " active" : "");
    b.innerHTML =
      '<span class="et">' + (eid ? '<span class="eid">' + eid + "</span>" : "") + escapeHtml(title) + "</span>" +
      '<span class="ep-prog"><span class="mini"><i style="width:' + p.pct + '%"></i></span>' + p.d + "/" + p.tot + "</span>";
    b.onclick = function () {
      state.epic = key;
      renderEpics();
      renderBoard();
    };
    return b;
  }

  function renderEpics() {
    var box = $("epics");
    box.innerHTML = "";
    var p = getProject();
    if (!p) return;
    var pa = prog(allTasks());
    box.appendChild(epicChip("all", "Tất cả tính năng", "", pa, state.epic === "all"));
    (p.epics || []).forEach(function (ep) {
      box.appendChild(epicChip(ep.id, ep.title, ep.id, prog(ep.tasks || []), state.epic === ep.id));
    });
  }

  function renderHeader() {
    var p = getProject();
    var pend = $("pending");
    if (!p) {
      $("prog-label").textContent = "—";
      $("prog-bar").style.width = "0%";
      pend.style.display = "none";
      return;
    }
    var all = allTasks();
    var pr = prog(all);
    var wait = all.filter(function (t) { return t.status === "uat"; }).length;
    $("prog-label").textContent = p.name + " · " + pr.d + "/" + pr.tot + " xong";
    $("prog-bar").style.width = pr.pct + "%";
    pend.innerHTML = "👀 <b>" + wait + "</b> việc chờ bạn duyệt";
    pend.style.display = wait ? "inline-flex" : "none";
  }

  function renderBoard() {
    var board = $("board");
    board.innerHTML = "";
    var rows = projectTasks().filter(function (r) {
      return state.epic === "all" || r.ep.id === state.epic;
    });

    COLUMNS.forEach(function (col) {
      var items = rows.filter(function (r) { return r.t.status === col.key; });
      var wrap = document.createElement("section");
      wrap.className = "col" + (col.key === "uat" ? " col-uat" : "");
      wrap.innerHTML =
        '<div class="col-head"><h2><span class="tick" style="background:' + col.tick + '"></span>' +
        col.title + '</h2><span class="count">' + items.length + "</span></div>";

      items.forEach(function (row) {
        wrap.appendChild(renderCard(row.t, row.ep));
      });
      board.appendChild(wrap);
    });
  }

  function renderCard(t, ep) {
    var a = AGENTS[t.agent] || { name: t.agent || "—", color: "var(--txt-hint)" };
    var card = document.createElement("article");
    card.className = ("card " + (t.status === "backlog" && t.reject ? "is-rejected" : STATE_CLASS[t.status] || "")).trim();
    card.tabIndex = 0;

    var tags = "";
    if (t.reject && t.status === "backlog") {
      tags += '<span class="tag reject">↺ Reject</span>';
    } else {
      depList(t).forEach(function (d) {
        tags += '<span class="tag ' + (t.depMet ? "met" : "") + '">' + (t.depMet ? "✓ " : "Chờ ") + escapeHtml(d) + "</span>";
      });
    }
    if (t.status === "uat") tags = '<span class="tag wait">Chờ bạn duyệt</span>' + tags;

    var check = t.status === "done" ? '<span class="check">✓ </span>' : "";
    card.innerHTML =
      '<div class="cardtop"><span class="id">' + escapeHtml(t.id) + "</span>" +
      '<span class="tag epic" title="' + escapeHtml(ep.title) + '">' + escapeHtml(ep.title) + "</span></div>" +
      '<div class="title">' + check + escapeHtml(t.title) + "</div>" +
      '<div class="meta"><span class="assignee"><i style="background:' + a.color + '"></i>' + a.name + "</span>" + tags + "</div>";

    if (t.status === "uat") {
      var bs = document.createElement("div");
      bs.className = "btns";
      var ap = document.createElement("button");
      ap.className = "btn btn-approve";
      ap.textContent = "Duyệt";
      ap.onclick = function () { poAction(t.id, "done", ap); };
      var rj = document.createElement("button");
      rj.className = "btn btn-reject";
      rj.textContent = "Trả lại";
      rj.onclick = function () { poAction(t.id, "backlog", rj); };
      bs.appendChild(ap);
      bs.appendChild(rj);
      card.appendChild(bs);
    }
    return card;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderAll() {
    renderTabs();
    renderEpics();
    renderHeader();
    renderBoard();
  }

  // --- data load -------------------------------------------------------------
  function load() {
    return fetchBoard()
      .then(function (data) {
        DATA = data && data.projects ? data : { projects: [] };
        var projects = DATA.projects || [];
        // Keep selected project if it still exists; else default to first.
        if (!projects.some(function (p) { return p.id === state.proj; })) {
          state.proj = projects[0] ? projects[0].id : null;
          state.epic = "all";
        } else {
          // Keep epic if it still exists in the selected project; else "all".
          var p = getProject();
          if (state.epic !== "all" && p && !(p.epics || []).some(function (e) { return e.id === state.epic; })) {
            state.epic = "all";
          }
        }
        renderAll();
      })
      .catch(function (e) {
        var board = $("board");
        if (board) {
          board.innerHTML =
            '<section class="col"><div class="col-head"><h2>Lỗi tải dữ liệu</h2></div>' +
            '<div style="font-size:12px;color:var(--error);padding:8px">' + escapeHtml(String(e && e.message ? e.message : e)) + "</div></section>";
        }
      });
  }

  // --- real-time (SSE) -------------------------------------------------------
  // On every `update` event, re-fetch /api/board and re-render. EventSource
  // reconnects automatically on drop. Selected project/epic are preserved by load().
  function connectStream() {
    if (typeof EventSource === "undefined") return;
    var es = new EventSource("/api/stream");
    es.addEventListener("update", function () { load(); });
    // Also handle default-named messages defensively.
    es.onmessage = function () { load(); };
  }

  // --- boot ------------------------------------------------------------------
  function boot() {
    load();
    connectStream();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
