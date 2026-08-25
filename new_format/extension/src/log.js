/*
 * log.js - a run log you can copy out of the panel and paste back to whoever is
 * debugging this.
 *
 * Every fetch, cache decision and parse result is recorded with a millisecond
 * offset from the start of the run. The last few runs are kept in
 * chrome.storage.local, so a bad run can still be read after the page is gone.
 *
 * Nothing here is sensitive: it is public page URLs, element counts and error
 * messages. Page contents are never logged, only sizes and small excerpts when
 * a parse fails.
 */

var PMTLog = (function () {
  var entries = [];
  var startedAt = 0;
  var runLabel = '';

  function now() { return Date.now(); }

  function add(level, step, data) {
    var e = { ms: startedAt ? now() - startedAt : 0, level: level, step: step };
    if (data !== undefined) e.data = data;
    entries.push(e);
    var line = '[PMT ' + String(e.ms).padStart(5) + 'ms] ' + step;
    if (level === 'error') console.error(line, data || '');
    else if (level === 'warn') console.warn(line, data || '');
    else console.info(line, data === undefined ? '' : data);
    return e;
  }

  return {
    start: function (label) {
      entries = [];
      startedAt = now();
      runLabel = label || '';
      add('info', 'run started', { page: label, userAgent: navigator.userAgent, version: version() });
    },
    info: function (step, data) { return add('info', step, data); },
    warn: function (step, data) { return add('warn', step, data); },
    // for a thrown Error - unwraps the message and a short stack
    error: function (step, err) {
      return add('error', step, {
        message: (err && err.message) || String(err),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : undefined
      });
    },
    // for an error-level event whose payload is already structured data
    fail: function (step, data) { return add('error', step, data); },
    // wraps a promise so its duration and outcome land in the log
    track: function (step, promise, describe) {
      var t = now();
      return promise.then(function (v) {
        add('info', step + ' ok', Object.assign({ ms: now() - t }, describe ? describe(v) : {}));
        return v;
      }, function (e) {
        add('error', step + ' failed', { ms: now() - t, message: (e && e.message) || String(e) });
        throw e;
      });
    },
    entries: function () { return entries.slice(); },
    counts: function () {
      var c = { warn: 0, error: 0 };
      entries.forEach(function (e) { if (c[e.level] !== undefined) c[e.level]++; });
      return c;
    },
    text: function () {
      var out = ['# HLTV post-match thread - run log', '# ' + runLabel, ''];
      entries.forEach(function (e) {
        var line = String(e.ms).padStart(6) + 'ms  ' + e.level.toUpperCase().padEnd(5) + ' ' + e.step;
        if (e.data !== undefined) line += '  ' + JSON.stringify(e.data);
        out.push(line);
      });
      return out.join('\n');
    },
    save: function () {
      if (typeof chrome === 'undefined' || !chrome.storage) return;
      var snapshot = { at: new Date(startedAt || now()).toISOString(), label: runLabel, entries: entries };
      chrome.storage.local.get(['pmt:logs'], function (v) {
        var logs = (v && v['pmt:logs']) || [];
        logs.push(snapshot);
        chrome.storage.local.set({ 'pmt:logs': logs.slice(-5) });   // keep the last five runs
      });
    }
  };

  function version() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
  }
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { PMTLog: PMTLog };
