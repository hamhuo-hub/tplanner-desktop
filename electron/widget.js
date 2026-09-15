import { applyCategory, initializeWindowControls } from './widget-shared.mjs';

/* tPlanner Today Widget — vanilla renderer.
 *
 * It renders the read-only projection that the React renderer pushes to main:
 * rows carry { uid, title, start, due, completed, checklist, note, colorId, dateKey,
 * repeats, pending } with epoch-millisecond times and null for an absent time. Ticking a
 * task is an INTENT — main relays it to the renderer, which owns the canonical store.
 * This file never persists anything and never assumes an intent applied.
 */
(function () {
  'use strict';

  var DOWS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  var state = {
    rows: [],
    now: new Date(),
  };

  // Persist completed-section collapsed state across sessions
  var completedCollapsed = localStorage.getItem('widget_completed_collapsed') !== 'false';
  function saveCollapsed(v) {
    completedCollapsed = v;
    localStorage.setItem('widget_completed_collapsed', v ? 'true' : 'false');
  }

  // ── DOM helpers ────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function fmtDate(d) { return d.getMonth() + 1 + '月' + d.getDate() + '日 · ' + DOWS[d.getDay()]; }
  function todayKeyOf(now) {
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  /** A task's deadline is DUE when present, otherwise DTSTART. Never invented. */
  function dueAt(row) {
    return row.due !== null && row.due !== undefined ? row.due
      : (row.start !== null && row.start !== undefined ? row.start : null);
  }

  // ── Filtering / sorting ────────────────────────────────────────────
  // Today = today's date key, or anything already overdue and unfinished. `dateKey` is
  // computed once by the renderer with the user's display timezone, so this widget never
  // re-derives a date and cannot disagree with the main window.
  function rowsForToday() {
    var nowTs = state.now.getTime();
    var today = todayKeyOf(state.now);
    return state.rows.filter(function (row) {
      if (row.dateKey === today) return true;
      var deadline = dueAt(row);
      return deadline !== null && deadline < nowTs && !row.completed;
    }).sort(function (a, b) {
      var left = dueAt(a); var right = dueAt(b);
      if (left === null) return right === null ? String(a.title).localeCompare(String(b.title)) : 1;
      if (right === null) return -1;
      return left - right;
    });
  }

  function statusFor(row, nowTs) {
    var deadline = dueAt(row);
    if (deadline === null) return 'unscheduled';
    if (deadline < nowTs) return 'past';
    if (deadline - nowTs <= 5 * 60 * 1000) return 'soon';
    return 'future';
  }

  // ── Render ─────────────────────────────────────────────────────────
  function renderHeader() {
    $('hdr-date').textContent = fmtDate(state.now);
    var todays = rowsForToday();
    $('hdr-sub').textContent = todays.length === 0
      ? '今日空闲'
      : '今日 ' + todays.length + ' 项';
  }

  function renderList() {
    var list = $('list');
    clear(list);
    var todays = rowsForToday();
    if (todays.length === 0) {
      var empty = el('div', 'empty');
      var icon = el('div', 'empty-icon'); icon.textContent = '✓';
      icon.setAttribute('aria-hidden', 'true');
      var text = el('div', 'empty-text'); text.textContent = '今天没有安排，享受清闲吧';
      empty.appendChild(icon);
      empty.appendChild(text);
      list.appendChild(empty);
      return;
    }

    var nowTs = state.now.getTime();
    var groups = { current: [], upcoming: [], past: [], done: [], unscheduled: [] };
    todays.forEach(function (row) {
      // Completed tasks go to a dedicated "done" group
      if (row.completed) { groups.done.push(row); return; }
      var st = statusFor(row, nowTs);
      if (st === 'unscheduled') groups.unscheduled.push(row);
      else if (st === 'past') groups.past.push(row);
      else if (st === 'soon') groups.current.push(row);
      else groups.upcoming.push(row);
    });

    var sections = [
      { key: 'current',  label: '即将到期', list: groups.current },
      { key: 'upcoming', label: '稍后',   list: groups.upcoming },
      { key: 'past',     label: '已逾期', list: groups.past },
      { key: 'unscheduled', label: '无时间', list: groups.unscheduled },
    ];

    sections.forEach(function (sec) {
      if (sec.list.length === 0) return;
      var hd = el('div', 'group-label');
      hd.appendChild(document.createTextNode(sec.label));
      var c = el('span', 'count'); c.textContent = sec.list.length;
      hd.appendChild(c);
      list.appendChild(hd);
      sec.list.forEach(function (e) { list.appendChild(renderItem(e, nowTs, sec.key)); });
    });

    // ── Completed section (collapsible) ──────────────────────────────────
    if (groups.done.length > 0) {
      var doneHd = el('button', 'group-label group-toggle');
      doneHd.type = 'button';
      doneHd.setAttribute('aria-expanded', String(!completedCollapsed));
      doneHd.setAttribute('aria-controls', 'completed-items');

      var doneLabel = document.createTextNode('已完成 ');
      doneHd.appendChild(doneLabel);
      var doneCount = el('span', 'count'); doneCount.textContent = groups.done.length;
      doneHd.appendChild(doneCount);

      var arrow = el('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = completedCollapsed ? '▶' : '▼';
      doneHd.appendChild(arrow);

      var doneBody = el('div');
      doneBody.id = 'completed-items';
      doneBody.style.display = completedCollapsed ? 'none' : '';
      groups.done.forEach(function (e) { doneBody.appendChild(renderItem(e, nowTs, 'done')); });

      doneHd.addEventListener('click', function () {
        saveCollapsed(!completedCollapsed);
        doneHd.setAttribute('aria-expanded', String(!completedCollapsed));
        doneBody.style.display = completedCollapsed ? 'none' : '';
        arrow.textContent = completedCollapsed ? '▶' : '▼';
      });

      list.appendChild(doneHd);
      list.appendChild(doneBody);
    }
  }

  function renderItem(e, nowTs, sectionKey) {
    var status = statusFor(e, nowTs);
    var checklist = e.checklist || [];
    var hasChecklist = checklist.length > 0;
    var doneCount = checklist.filter(function(i) { return i.completed; }).length;
    var allDone = hasChecklist ? doneCount === checklist.length : true;

    var completed = Boolean(e.completed);
    var item = el('div', 'item task'
      + (completed ? ' done' : '')
      + (!completed && status === 'past' ? ' past' : ''));
    applyCategory(item, e.colorId);

    var bullet = el('button', 'task-check');
    bullet.type = 'button';
    bullet.setAttribute('role', 'checkbox');
    bullet.setAttribute('aria-checked', String(completed));
    bullet.setAttribute('aria-label', (completed ? '取消完成：' : '完成：') + (e.title || '无标题任务'));
    var check = el('span', 'check-mark');
    check.setAttribute('aria-hidden', 'true');
    check.textContent = completed ? '✓' : '';
    bullet.appendChild(check);
    // Block the parent toggle until every checklist item is done
    var blocked = hasChecklist && !allDone && !completed;
    bullet.title = blocked ? '请先完成所有子任务' : '';
    bullet.disabled = blocked;
    if (blocked) bullet.setAttribute('aria-label', '请先完成所有子任务：' + (e.title || '无标题任务'));
    bullet.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (blocked) return;
      if (window.widgetAPI && window.widgetAPI.toggleTask) {
        window.widgetAPI.toggleTask(e.uid);
      }
    });
    item.appendChild(bullet);

    var body = el('div', 'item-body');
    var row1 = el('div', 'item-row1');
    var title = el('span', 'item-title');
    title.textContent = e.title || '(无标题)';
    title.title = e.title || '';
    row1.appendChild(title);

    // Subtask progress badge
    if (hasChecklist) {
      var badge = el('button', 'progress-badge' + (allDone ? ' done-all' : ''));
      badge.type = 'button';
      badge.setAttribute('aria-expanded', 'true');
      badge.setAttribute('aria-label', '子任务：已完成 ' + doneCount + ' 项，共 ' + checklist.length + ' 项；收起或展开');
      badge.textContent = doneCount + '/' + checklist.length;
      row1.appendChild(badge);
    }

    if (completed) {
      var tag3 = el('span', 'item-tag done'); tag3.textContent = '完成';
      row1.appendChild(tag3);
    } else if (status === 'soon') {
      var tag2 = el('span', 'item-tag soon'); tag2.textContent = '即将';
      row1.appendChild(tag2);
    } else if (status === 'past') {
      var pastTag = el('span', 'item-tag past'); pastTag.textContent = '已逾期';
      row1.appendChild(pastTag);
    }
    if (e.pending) {
      var pendingTag = el('span', 'item-tag soon'); pendingTag.textContent = '待上传';
      row1.appendChild(pendingTag);
    }
    body.appendChild(row1);

    var row2 = el('div', 'item-row1');
    var time = el('span', 'item-time');
    if (e.start === null || e.start === undefined) {
      time.textContent = e.due !== null && e.due !== undefined ? '截止 ' + fmtTime(e.due) : '无时间';
    } else {
      time.textContent = e.due !== null && e.due !== undefined
        ? fmtTime(e.start) + ' – ' + fmtTime(e.due)
        : fmtTime(e.start);
    }
    row2.appendChild(time);
    if (e.note) {
      var note = el('span', 'item-note');
      note.textContent = e.note;
      note.title = e.note;
      row2.appendChild(note);
    }
    body.appendChild(row2);

    // Subtask list (collapsible)
    if (hasChecklist) {
      var subtaskOpen = true; // default expanded
      var subtaskList = el('div', 'subtask-list');

      function renderSubtasks() {
        clear(subtaskList);
        checklist.forEach(function(sub) {
          var subId = sub.id;
          var row = el('button', 'subtask-item');
          row.type = 'button';
          row.setAttribute('role', 'checkbox');
          row.setAttribute('aria-checked', String(Boolean(sub.completed)));

          var sbullet = el('span', 'check-mark');
          sbullet.setAttribute('aria-hidden', 'true');
          sbullet.textContent = sub.completed ? '✓' : '';
          row.addEventListener('click', function(ev) {
            ev.stopPropagation();
            if (window.widgetAPI && window.widgetAPI.toggleSubtask) {
              window.widgetAPI.toggleSubtask(e.uid, subId);
            }
          });
          row.appendChild(sbullet);

          var stext = el('span', 'subtask-text' + (sub.completed ? ' done' : ''));
          stext.textContent = sub.text || '';
          row.appendChild(stext);
          subtaskList.appendChild(row);
        });
      }
      renderSubtasks();

      // Toggle expand/collapse via clicking the progress badge
      if (badge) {
        badge.addEventListener('click', function(ev) {
          ev.stopPropagation();
          subtaskOpen = !subtaskOpen;
          badge.setAttribute('aria-expanded', String(subtaskOpen));
          subtaskList.style.display = subtaskOpen ? '' : 'none';
        });
      }

      body.appendChild(subtaskList);
    }

    item.appendChild(body);
    return item;
  }

  function renderStats() {
    var todays = rowsForToday();
    var taskTotal = todays.length;
    var taskDone  = todays.filter(function (e) { return e.completed; }).length;
    var stats = $('stats');
    clear(stats);
    var s1 = el('span'); s1.textContent = '任务 ' + taskDone + '/' + taskTotal;
    stats.appendChild(s1);
    var nowStr = fmtTime(state.now);
    var s3 = el('span'); s3.textContent = '· ' + nowStr;
    stats.appendChild(s3);
  }

  function render() {
    state.now = new Date();
    renderHeader();
    renderList();
    renderStats();
  }

  // ── Event wiring ───────────────────────────────────────────────────
  function setEvents(arr) {
    // The projection already carries epoch milliseconds and null for an absent time.
    state.rows = Array.isArray(arr) ? arr.slice() : [];
    render();
  }

  function init() {
    var api = window.widgetAPI;
    if (!api) {
      // Preload not loaded — show a clear error so the user reports it
      var list = $('list');
      clear(list);
      var msg = el('div', 'empty error');
      msg.setAttribute('role', 'alert');
      msg.innerHTML = '<div class="empty-icon" aria-hidden="true">!</div>'
        + '<div class="empty-text">暂时无法加载今日安排，请重新打开便签。</div>';
      list.appendChild(msg);
      return;
    }

    // Initial pull from main (the renderer pushes an update as soon as it has one)
    api.getEvents().then(setEvents).catch(function () { setEvents([]); });

    // Live updates from main process
    api.onEvents(setEvents);

    initializeWindowControls(api);
    $('btn-refresh').addEventListener('click', function () {
      api.getEvents().then(setEvents);
    });

    // Re-render every 30s so "upcoming/overdue" stays accurate between projections
    setInterval(render, 30 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
