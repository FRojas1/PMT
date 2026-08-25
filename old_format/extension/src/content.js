/*
 * content.js - the bit that runs on an HLTV match page.
 *
 * Injects a "Post-Match Thread" button. Clicking it scrapes the page (all map
 * tabs are already in the DOM, they are only hidden with display:none, so no
 * clicking through them is needed), fetches the two things the match page does
 * not carry - the event's venue and the current VRS ranking date - renders the
 * markdown, copies it, and opens the reddit submit page.
 */

var DEFAULTS = {
  subreddit: 'GlobalOffensive',
  autoOpen: true,
  flair: 'Discussion | Esports',
  logoOverrides: {}
};

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(DEFAULTS, function (v) { resolve(v || DEFAULTS); });
  });
}

/* ------------------------------------------------------------ hltv fetches */

/* Nothing is cached: every generation re-reads the live pages, so a thread can
 * never be built from a prize pool or ranking date that has since moved. It is
 * two extra requests per thread. */

function fetchDoc(url) {
  return fetch(url, { credentials: 'include' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.text().then(function (html) {
      return { doc: new DOMParser().parseFromString(html, 'text/html'), url: r.url };
    });
  });
}

// /valve-ranking/teams redirects to the latest dated ranking, e.g.
// /valve-ranking/teams/2026/august/25 - that path is what the body links to.
function fetchVrsDate() {
  return fetchDoc('https://www.hltv.org/valve-ranking/teams').then(function (res) {
    var m = res.url.match(/\/valve-ranking\/teams\/(\d{4}\/[a-z]+\/\d+)/i);
    if (m) return m[1];
    var link = res.doc.querySelector('a[href*="/valve-ranking/teams/"]');
    var href = link ? link.getAttribute('href') : '';
    return (href.match(/\/valve-ranking\/teams\/(\d{4}\/[a-z]+\/\d+)/i) || [])[1] || '';
  });
}

// Only the venue is missing from the match page: td.location holds
// "Paris, France" or "Europe (Online)" plus the country flag. The prize pool
// comes off the match page's own sidebar.
function fetchSetting(eventUrl) {
  if (!eventUrl) return Promise.resolve(null);
  return fetchDoc(eventUrl).then(function (res) {
    var locTd = res.doc.querySelector('td.location');
    if (!locTd) return null;
    var place = locTd.textContent.replace(/\s+/g, ' ').trim()
      .replace(/\s*\((?:Online|LAN)\)\s*$/i, '')   // "Europe (Online)" -> "Europe"
      .split(',')[0].trim();                          // "Paris, France"   -> "Paris"
    var img = locTd.querySelector('img');
    var src = img ? img.getAttribute('src') || '' : '';
    var flag = (src.match(/\/flags\/[^/]*\/([A-Za-z_-]+)\./) || [])[1] || '';
    return { place: place, flag: flag.toUpperCase() };
  });
}

/* ------------------------------------------------------------------- panel */

var panel = null;
var current = { title: '', body: '' };

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(legacyCopy.bind(null, text));
  }
  return legacyCopy(text);
}

function legacyCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}

// selftext=true puts old.reddit's submit form on the "text post" tab.
// The flair is carried in the hash so reddit ignores it but reddit.js can read
// it - a query param would end up in the submitted post's URL.
function submitUrl(title, subreddit, flair) {
  return 'https://old.reddit.com/r/' + encodeURIComponent(subreddit) +
    '/submit?selftext=true&title=' + encodeURIComponent(title) +
    (flair ? '#pmt-flair=' + encodeURIComponent(flair) : '');
}

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildPanel() {
  panel = el('div', 'pmt-panel');

  var head = el('div', 'pmt-head');
  head.appendChild(el('span', 'pmt-title-label', 'Post-Match Thread'));
  var close = el('button', 'pmt-x', '×');
  close.onclick = function () { panel.classList.remove('pmt-open'); };
  head.appendChild(close);
  panel.appendChild(head);

  panel.appendChild(el('label', 'pmt-label', 'Thread title'));
  var titleIn = el('input', 'pmt-input');
  titleIn.id = 'pmt-title';
  panel.appendChild(titleIn);

  panel.appendChild(el('label', 'pmt-label', 'Highlights (one per line: Title | url)'));
  var hl = el('textarea', 'pmt-hl');
  hl.id = 'pmt-hl';
  hl.placeholder = 'M1R14 | Staehr - 1vs4 clutch | https://clips.twitch.tv/...';
  hl.rows = 3;
  panel.appendChild(hl);

  panel.appendChild(el('label', 'pmt-label', 'Body (markdown)'));
  var body = el('textarea', 'pmt-body');
  body.id = 'pmt-body';
  panel.appendChild(body);

  var row = el('div', 'pmt-row');
  var regen = el('button', 'pmt-btn', 'Regenerate');
  regen.onclick = function () { generate({ silent: true, noOpen: true }); };
  var copy = el('button', 'pmt-btn pmt-primary', 'Copy body');
  copy.onclick = function () {
    copyText(document.getElementById('pmt-body').value)
      .then(function () { status('Copied to clipboard.'); })
      .catch(function () { status('Copy failed - select the text and press Ctrl+C.', true); });
  };
  var open = el('button', 'pmt-btn', 'Open reddit submit');
  open.onclick = function () {
    getSettings().then(function (s) {
      chrome.runtime.sendMessage({
        type: 'openTab',
        url: submitUrl(document.getElementById('pmt-title').value, s.subreddit, s.flair)
      });
    });
  };
  row.appendChild(regen);
  row.appendChild(copy);
  row.appendChild(open);
  panel.appendChild(row);

  panel.appendChild(el('div', 'pmt-status', ''));
  document.body.appendChild(panel);
  return panel;
}

function status(msg, isError) {
  if (!panel) return;
  var s = panel.querySelector('.pmt-status');
  s.textContent = msg;
  s.className = 'pmt-status' + (isError ? ' pmt-error' : '');
}

function parseHighlights(raw) {
  return String(raw || '').split('\n').map(function (line) {
    var i = line.lastIndexOf('|');
    if (i < 0) return null;
    var title = line.slice(0, i).trim();
    var url = line.slice(i + 1).trim();
    return title && /^https?:/.test(url) ? { title: title, url: url } : null;
  }).filter(Boolean);
}

/* ---------------------------------------------------------------- generate */

var busy = false;

function generate(opts) {
  opts = opts || {};
  if (busy) return;
  busy = true;
  if (!panel) buildPanel();
  panel.classList.add('pmt-open');
  status('Reading match page…');

  var hlBox = document.getElementById('pmt-hl');
  var data;
  try {
    data = scrapeMatch(document, location.href);
  } catch (e) {
    busy = false;
    status('Could not read the match page: ' + e.message, true);
    return;
  }
  if (!data.teams[0] || !data.teams[0].name) {
    busy = false;
    status('This does not look like a finished match page.', true);
    return;
  }

  // Show HLTV's own clip highlights so they can be edited or added to. While the
  // box is untouched the page's are used verbatim: their exact text (trailing
  // and double spaces included) is what the sample threads carry, and a
  // round-trip through the textarea would normalise it away.
  if (!hlBox.value && data.highlights.length) {
    hlBox.value = data.highlights.map(function (h) { return h.title + ' | ' + h.url; }).join('\n');
    hlBox.dataset.pristine = hlBox.value;
  }
  var highlights = hlBox.value === hlBox.dataset.pristine
    ? data.highlights
    : parseHighlights(hlBox.value);

  status('Fetching event + VRS details…');
  Promise.all([getSettings(), fetchVrsDate(), fetchSetting(data.event.url)])
    .then(function (r) {
      var settings = r[0];
      var extra = {
        vrsDate: r[1] || '',
        setting: r[2],
        highlights: highlights,
        logoOverrides: settings.logoOverrides
      };
      current.title = buildTitle(data);
      current.body = buildBody(data, extra);
      document.getElementById('pmt-title').value = current.title;
      document.getElementById('pmt-body').value = current.body;

      var notes = [];
      if (!extra.vrsDate) notes.push('VRS date unavailable');
      if (!extra.setting) notes.push('event venue unavailable');
      if (!data.vrs) notes.push('no VRS forecast on this page');

      return copyText(current.body)
        .then(function () { return 'Body copied.'; })
        .catch(function () { return 'Copy blocked - use the Copy body button.'; })
        .then(function (copyMsg) {
          status(copyMsg + (notes.length ? ' (' + notes.join('; ') + ')' : ''),
                 /blocked/.test(copyMsg));
          if (settings.autoOpen && !opts.noOpen) {
            chrome.runtime.sendMessage({
              type: 'openTab',
              url: submitUrl(current.title, settings.subreddit, settings.flair)
            });
          }
        });
    })
    .catch(function (e) { status('Failed: ' + e.message, true); })
    .then(function () { busy = false; });
}

/* -------------------------------------------------------------- entrypoint */

function injectButton() {
  if (document.querySelector('.pmt-launch')) return;
  var btn = el('button', 'pmt-launch', 'Post-Match Thread');
  btn.title = 'Generate the r/GlobalOffensive post-match thread';
  btn.onclick = function () { generate(); };
  document.body.appendChild(btn);
}

if (document.querySelector('.teamsBox')) injectButton();

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'generate') generate();
});
