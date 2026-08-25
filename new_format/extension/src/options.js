var DEFAULTS = {
  subreddit: 'GlobalOffensive',
  autoOpen: true,
  flair: 'Discussion | Esports',
  flairSelector: '.linkflair.linkflair-discussion.linkflair-esports > .linkflairlabel',
  flairApplySelector: '#newlink-flair-dropdown > form > button',
  logoOverrides: {}
};

function toText(map) {
  return Object.keys(map || {}).sort().map(function (k) { return k + ' = ' + map[k]; }).join('\n');
}

function toMap(text) {
  var out = {};
  String(text || '').split('\n').forEach(function (line) {
    var i = line.indexOf('=');
    if (i < 0) return;
    var name = line.slice(0, i).trim().toLowerCase();
    var slug = line.slice(i + 1).trim().toLowerCase();
    if (name && slug) out[name] = slug;
  });
  return out;
}

chrome.storage.sync.get(DEFAULTS, function (v) {
  document.getElementById('subreddit').value = v.subreddit;
  document.getElementById('autoOpen').checked = !!v.autoOpen;
  document.getElementById('flair').value = v.flair;
  document.getElementById('flairSelector').value = v.flairSelector;
  document.getElementById('flairApplySelector').value = v.flairApplySelector;
  document.getElementById('logos').value = toText(v.logoOverrides);
});

document.getElementById('save').addEventListener('click', function () {
  chrome.storage.sync.set({
    subreddit: document.getElementById('subreddit').value.trim().replace(/^\/?r\//, '') || 'GlobalOffensive',
    autoOpen: document.getElementById('autoOpen').checked,
    flair: document.getElementById('flair').value.trim(),
    flairSelector: document.getElementById('flairSelector').value.trim(),
    flairApplySelector: document.getElementById('flairApplySelector').value.trim(),
    logoOverrides: toMap(document.getElementById('logos').value)
  }, function () {
    var s = document.getElementById('status');
    s.textContent = 'Saved';
    setTimeout(function () { s.textContent = ''; }, 1500);
  });
});

/* ------------------------------------------------------------- diagnostics */

function logText(run) {
  return ['# HLTV post-match thread - run log', '# ' + run.label, '# ' + run.at, '']
    .concat(run.entries.map(function (e) {
      return String(e.ms).padStart(6) + 'ms  ' + e.level.toUpperCase().padEnd(5) + ' ' + e.step +
        (e.data === undefined ? '' : '  ' + JSON.stringify(e.data));
    })).join('\n');
}

function renderRuns() {
  chrome.storage.local.get(['pmt:logs'], function (v) {
    var runs = (v && v['pmt:logs']) || [];
    var host = document.getElementById('runs');
    host.textContent = '';
    if (!runs.length) {
      host.appendChild(Object.assign(document.createElement('p'),
        { className: 'hint', textContent: 'No runs recorded yet.' }));
      return;
    }
    runs.slice().reverse().forEach(function (run) {
      var bad = run.entries.filter(function (e) { return e.level === 'warn' || e.level === 'error'; });
      var box = document.createElement('div');
      box.className = 'run';

      var h = document.createElement('h3');
      h.textContent = run.at;
      box.appendChild(h);

      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = run.label + ' — ' + run.entries.length + ' steps, ';
      var count = document.createElement('span');
      count.className = bad.length ? 'bad' : '';
      count.textContent = bad.length + ' warning/error' + (bad.length === 1 ? '' : 's');
      meta.appendChild(count);
      box.appendChild(meta);

      var pre = document.createElement('pre');
      pre.textContent = logText(run);

      var copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.addEventListener('click', function () {
        navigator.clipboard.writeText(logText(run)).then(function () {
          copy.textContent = 'Copied';
          setTimeout(function () { copy.textContent = 'Copy'; }, 1200);
        });
      });
      var show = document.createElement('button');
      show.textContent = 'Show';
      show.addEventListener('click', function () {
        pre.classList.toggle('open');
        show.textContent = pre.classList.contains('open') ? 'Hide' : 'Show';
      });

      box.appendChild(copy);
      box.appendChild(show);
      box.appendChild(pre);
      host.appendChild(box);
    });
  });
}

document.getElementById('clearLogs').addEventListener('click', function () {
  chrome.storage.local.remove('pmt:logs', renderRuns);
});

// The Liquipedia link cache never expires, so this is how a wrong match gets undone.
document.getElementById('clearCache').addEventListener('click', function () {
  chrome.storage.local.get(null, function (all) {
    var keys = Object.keys(all).filter(function (k) { return k.indexOf('lp:') === 0; });
    chrome.storage.local.remove(keys, function () {
      var s = document.getElementById('cacheStatus');
      s.textContent = 'Forgot ' + keys.length + ' link' + (keys.length === 1 ? '' : 's');
      setTimeout(function () { s.textContent = ''; }, 2500);
    });
  });
});

renderRuns();
