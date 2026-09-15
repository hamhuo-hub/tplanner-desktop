import { initializeWindowControls } from './widget-shared.mjs';

/* tPlanner Daily Note widget — vanilla renderer.
 *
 * The note it shows IS the canonical VJOURNAL document: the renderer pushes
 * { dayKey, text } and a save is only an INTENT. The widget never keeps a note store and
 * never writes files; the main app owns the jCal document and the sync queue.
 */
(function () {
  'use strict';

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function $(id) { return document.getElementById(id); }

  function showSaved() {
    var el = $('save-indicator');
    el.textContent = '已保存';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.textContent = ''; }, 1200);
  }

  function renderMd(text) {
    if (!text || !text.trim()) return '';
    return marked.parse(text, { async: false, breaks: true });
  }

  function showRendered(el, rawText) {
    el.classList.add('rendered');
    el.innerHTML = renderMd(rawText);
    $('mode-hint').textContent = '点击编辑';
  }

  function showRaw(el, rawText) {
    el.classList.remove('rendered');
    el.textContent = rawText;
    $('mode-hint').textContent = 'Markdown';
    // Move cursor to end
    var range = document.createRange();
    var sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function init() {
    var api = window.notesAPI;
    var editor = $('notes-editor');
    var rawText = '';
    var dayKey = todayKey();
    var operationStartText = '';

    if (!api) {
      editor.textContent = '暂时无法加载随笔，请重新打开便签。';
      editor.contentEditable = 'false';
      return;
    }

    // Today's canonical note text, if the renderer has published it yet.
    api.getCurrentNote().then(function (payload) {
      if (!payload || payload.dayKey !== dayKey) return;
      rawText = payload.text || '';
      if (rawText) showRendered(editor, rawText);
    });

    // External update (edited in the main window, or a snapshot installed)
    api.onNoteUpdated(function (payload) {
      if (!payload || payload.dayKey !== dayKey) return;
      rawText = payload.text || '';
      if (document.activeElement !== editor) {
        showRendered(editor, rawText);
      } else {
        editor.textContent = rawText;
      }
    });

    // Focus → switch to raw markdown for editing
    editor.addEventListener('focus', function () {
      operationStartText = rawText;
      if (editor.classList.contains('rendered')) {
        showRaw(editor, rawText);
      }
    });

    // Input only updates the in-memory draft. One focus→blur session is one operation, and
    // only a changed session produces a save intent.
    // 用 innerText 而不是 textContent：contenteditable 里按回车会插入 <div>/<br>，
    // textContent 只拼接文本节点、吞掉这些块级换行，导致保存时丢失所有换行符。
    editor.addEventListener('input', function () {
      rawText = editor.innerText;
    });

    editor.addEventListener('blur', function () {
      rawText = editor.innerText;
      showRendered(editor, rawText);
      if (rawText !== operationStartText) {
        // Intent only: the renderer persists the canonical VJOURNAL document.
        api.saveNote({ dayKey: dayKey, text: rawText });
        showSaved();
      }
      operationStartText = rawText;
    });

    initializeWindowControls(api);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
