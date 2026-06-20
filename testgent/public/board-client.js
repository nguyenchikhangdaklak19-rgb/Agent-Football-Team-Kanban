/*
 * board-client.js — authenticated client for the Team Board (Vercel edition).
 *
 * Drives the static shell in index.html from the auth-protected API:
 *   - GET  /api/board   -> { workflow, projects }   (requires session cookie)
 *   - POST /api/login   -> sets HttpOnly session cookie
 *   - POST /api/move    -> PO Duyệt/Trả lại actions (requires session cookie)
 *
 * Auth flow:
 *   1. On boot, attempt GET /api/board with credentials:'same-origin'.
 *   2. If 401 → show login overlay, hide board.
 *   3. Login: POST /api/login { password }. On 200 → hide overlay, load board.
 *      On non-2xx → show error in #login-error, keep board hidden.
 *   4. After auth, poll /api/board every POLL_MS ms. If any fetch returns 401
 *      (session expired) → drop back to login screen.
 *   5. Logout button: POST /api/logout (best-effort), then drop to login.
 *   6. Refresh button: immediate re-fetch without waiting for the poll timer.
 *
 * SSE / EventSource has been removed — the spec explicitly out-of-scopes it.
 *
 * Vanilla JS, no deps, no build.
 */
(function () {
  "use strict";

  // Poll interval for background refresh after login (ms).
  var POLL_MS = 30000;

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
  // Selected project id + epic id ("all" = aggregate). Preserved across poll
  // re-renders; reset epic to "all" only when the project changes.
  var DATA = { projects: [] };
  var state = { proj: null, epic: "all" };

  // Background poll timer handle.
  var pollTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  // --- login / session UI helpers --------------------------------------------

  function showLogin(errorMsg) {
    var overlay = $("login-overlay");
    var content = $("board-content");
    if (overlay) overlay.removeAttribute("hidden");
    if (content) content.setAttribute("hidden", "");
    // Reset form state.
    var pw = $("login-password");
    if (pw) { pw.value = ""; pw.focus(); }
    var errEl = $("login-error");
    if (errEl) errEl.textContent = errorMsg || "";
    stopPoll();
  }

  function showBoard() {
    var overlay = $("login-overlay");
    var content = $("board-content");
    if (overlay) overlay.setAttribute("hidden", "");
    if (content) content.removeAttribute("hidden");
  }

  function setLoginError(msg) {
    var el = $("login-error");
    if (el) el.textContent = msg || "";
  }

  function setLoginBusy(busy) {
    var btn = $("login-submit");
    var pw = $("login-password");
    if (btn) btn.disabled = busy;
    if (pw) pw.disabled = busy;
  }

  // --- poll helpers ----------------------------------------------------------

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () { load(); }, POLL_MS);
  }

  function stopPoll() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // --- API -------------------------------------------------------------------

  function fetchBoard() {
    return fetch("/api/board", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  }

  function postLogin(password) {
    return fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password }),
    });
  }

  function postLogout() {
    return fetch("/api/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(function () { /* best-effort */ });
  }

  function postMove(payload) {
    return fetch("/api/move", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (r.status === 401) {
        showLogin("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
        return { ok: false, error: "Phiên đăng nhập đã hết hạn." };
      }
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; });
    });
  }

  // --- PO actions ------------------------------------------------------------
  function poAction(id, to, btn) {
    if (btn) btn.disabled = true;
    postMove({ id: id, to: to, by: "po" })
      .then(function (res) {
        if (res && res.ok) {
          // Refresh immediately after the action.
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
  // Returns a promise that resolves to true (success) or false (needs login).
  function load() {
    return fetchBoard()
      .then(function (r) {
        if (r.status === 401) {
          showLogin("Phi\xEAn đăng nhập đ\xE3 hết hạn. Vui l\xF2ng đăng nhập lại.");
          return false;
        }
        if (!r.ok) {
          throw new Error("GET /api/board " + r.status);
        }
        return r.json();
      })
      .then(function (data) {
        if (data === false) return false;
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
        return true;
      })
      .catch(function (e) {
        var board = $("board");
        if (board) {
          board.innerHTML =
            '<section class="col"><div class="col-head"><h2>Lỗi tải dữ liệu</h2></div>' +
            '<div style="font-size:12px;color:var(--error);padding:8px">' + escapeHtml(String(e && e.message ? e.message : e)) + "</div></section>";
        }
        return false;
      });
  }

  // --- login form handler ----------------------------------------------------
  function handleLogin(e) {
    e.preventDefault();
    var pw = $("login-password");
    var password = pw ? pw.value : "";
    if (!password) {
      setLoginError("Vui l\xF2ng nhập mật khẩu.");
      return;
    }
    setLoginError("");
    setLoginBusy(true);

    postLogin(password)
      .then(function (r) {
        if (r.ok) {
          // Server set the session cookie; now fetch the board.
          showBoard();
          return load().then(function () {
            startPoll();
          });
        } else {
          return r.json()
            .catch(function () { return {}; })
            .then(function (body) {
              var msg = (body && body.error) || "Mật khẩu kh\xF4ng đ\xFAng. Vui l\xF2ng thử lại.";
              setLoginError(msg);
            });
        }
      })
      .catch(function (err) {
        setLoginError("Lỗi kết nối: " + String(err && err.message ? err.message : err));
      })
      .then(function () {
        setLoginBusy(false);
      });
  }

  // --- logout ----------------------------------------------------------------
  function handleLogout() {
    stopPoll();
    postLogout().then(function () {
      showLogin("");
    });
  }

  // --- boot ------------------------------------------------------------------
  function boot() {
    // Wire up login form.
    var form = $("login-form");
    if (form) form.addEventListener("submit", handleLogin);

    // Wire up logout button.
    var logoutBtn = $("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);

    // Wire up manual refresh button.
    var refreshBtn = $("refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { load(); });

    // Attempt to load the board immediately. If session cookie is already valid
    // (e.g. user reloaded the page), we skip the login screen entirely.
    fetchBoard().then(function (r) {
      if (r.status === 401) {
        // Not authenticated — show login overlay (it is already visible by default).
        return;
      }
      if (!r.ok) {
        // Some other error; stay on login, show generic message.
        setLoginError("Kh\xF4ng thể kết nối tới server (" + r.status + ").");
        return;
      }
      return r.json().then(function (data) {
        // Already authenticated; load the board directly.
        DATA = data && data.projects ? data : { projects: [] };
        var projects = DATA.projects || [];
        if (projects.length) {
          state.proj = projects[0].id;
        }
        showBoard();
        renderAll();
        startPoll();
      });
    }).catch(function () {
      // Network error; leave on login, do nothing.
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
