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
