/*
 * content.js - runs on an HLTV match page and drives the whole thing.
 *
 * What gets fetched, per thread:
 *   - the HLTV event page      venue for the Setting line, and a name -> flag
 *                              directory used for the next opponent
 *   - a map stats page         only for maps that went to overtime; the match
 *                              page reports OT as a single aggregate, the
 *                              per-half split is in the round history
 *   - the Liquipedia event and team pages
 *
 * Liquipedia has no lookup by HLTV name, so those three pages are located by
 * search (Google, then Brave). Those lookups are the one thing that IS cached -
 * keyed by the HLTV URL, kept indefinitely, and editable in the panel - so a
 * team is only ever searched for once. Clearing a box in the panel forgets the
 * saved page and searches again. Page contents are always re-read, so a thread
 * can never be built from a stale roster or ranking.
 *
 * Whatever search returns is checked to be the *kind* of page that was asked
 * for before it is used: a tournament page parses cleanly into a team that
 * never existed, and prints as one.
 */

var DEFAULTS = {
  subreddit: 'GlobalOffensive',
  autoOpen: true,
  flair: 'Discussion | Esports',
  flairSelector: '.linkflair.linkflair-discussion.linkflair-esports > .linkflairlabel',
  flairApplySelector: '#newlink-flair-dropdown > form > button',
  logoOverrides: {}
};

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(DEFAULTS, function (v) { resolve(v || DEFAULTS); });
  });
}

/* ------------------------------------------------------------------ fetch */

// HLTV is same-origin from here; anything else has to go via the service worker.
// Every fetch is logged with its status, size and duration.
function fetchDoc(url, label) {
  var t0 = Date.now();
  var tag = label ? label + ' <- ' + url : url;

  if (url.indexOf('https://www.hltv.org') === 0) {
    return fetch(url, { credentials: 'include' }).then(function (r) {
      return r.text().then(function (t) {
        var info = { via: 'page', status: r.status, bytes: t.length, ms: Date.now() - t0 };
        if (r.ok) { PMTLog.info('fetch ' + tag, info); return { doc: parseHtml(t), url: r.url }; }
        info.excerpt = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
        PMTLog.fail('fetch ' + tag + ' rejected', info);
        throw new Error('HTTP ' + r.status);
      });
    }, function (e) {
      PMTLog.error('fetch ' + tag, e);
      throw e;
    });
  }

  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ type: 'fetchText', url: url }, function (res) {
      if (chrome.runtime.lastError) {
        PMTLog.error('fetch ' + tag, chrome.runtime.lastError);
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!res) {
        PMTLog.error('fetch ' + tag, new Error('no reply from service worker'));
        return reject(new Error('no reply from service worker'));
      }
      var info = {
        via: res.via || 'worker', status: res.status, statusText: res.statusText,
        bytes: res.bytes, ms: res.ms, contentType: res.contentType,
        redirectedTo: res.url !== url ? res.url : undefined,
        error: res.error, headers: res.headers, excerpt: res.excerpt,
        challenge: res.challenge, intercepted: res.intercepted,
        retriedAfter: res.retriedAfter, afterTabFetch: res.afterTabFetch
      };
      if (res.ok) PMTLog.info('fetch ' + tag, info);
      else PMTLog.fail('fetch ' + tag + ' rejected', info);
      if (!res.ok) return reject(new Error(res.error || ('HTTP ' + res.status)));
      resolve({ doc: parseHtml(res.text), url: res.url });
    });
  });
}

function parseHtml(text) {
  return new DOMParser().parseFromString(text, 'text/html');
}

/* --------------------------------------------------- liquipedia link cache */

function liquipediaCacheKey(kind, hltvUrl) {
  return 'lp:' + kind + ':' + hltvUrl;
}

function cacheGet(key) {
  return new Promise(function (resolve) {
    chrome.storage.local.get([key], function (v) { resolve(v[key] || ''); });
  });
}

function cacheSet(key, value) {
  var patch = {};
  patch[key] = value;
  chrome.storage.local.set(patch);
}

function cacheForget(key) {
  return new Promise(function (resolve) {
    chrome.storage.local.remove(key, function () { void chrome.runtime.lastError; resolve(); });
  });
}

/*
 * Resolve an HLTV entity to its Liquipedia page, remembering the answer.
 *
 * `forget` is an emptied box in the panel. Clearing one and hitting Regenerate
 * reads as "I do not want this page" - so the remembered answer is thrown away
 * and the search runs again from scratch, exactly as it would for a team being
 * seen for the first time. Reloading the same remembered link, which is what it
 * used to do, is the one thing that cannot be what was meant by clearing it.
 */
function liquipediaUrlFor(kind, hltvUrl, searchName, override, forget) {
  var key = liquipediaCacheKey(kind, hltvUrl);
  if (override) {
    PMTLog.info('liquipedia ' + kind + ' from panel override', { name: searchName, url: override });
    cacheSet(key, override);
    return Promise.resolve(override);
  }
  var remembered = forget
    ? cacheForget(key).then(function () {
        PMTLog.info('liquipedia ' + kind + ' box cleared - forgetting the saved page and searching again',
          { name: searchName, key: key });
        return '';
      })
    : cacheGet(key);
  return remembered.then(function (hit) {
    if (hit) {
      PMTLog.info('liquipedia ' + kind + ' cache hit', { name: searchName, key: key, url: hit });
      return hit;
    }
    if (!searchName) {
      PMTLog.warn('liquipedia ' + kind + ' skipped', { reason: 'no name to search for', key: key });
      return '';
    }
    PMTLog.info('liquipedia ' + kind + ' cache miss, searching', { name: searchName });
    return searchInTab(kind, searchName).then(function (res) {
      if (res.url) {
        PMTLog.info('liquipedia ' + kind + ' search hit',
          { name: searchName, url: res.url, via: res.via, trace: res.trace });
        cacheSet(key, res.url);
      } else {
        PMTLog.warn('liquipedia ' + kind + ' search found nothing',
          { name: searchName, via: res.via, error: res.error, trace: res.trace });
      }
      return res.url;
    });
  });
}

// The search runs in a background tab: a service-worker fetch gets a captcha
// that it can never solve, because solving one needs a browser running the
// page's JavaScript.
function searchInTab(kind, name) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage({ type: 'search', kind: kind, name: name }, function (res) {
      if (chrome.runtime.lastError) {
        return resolve({ url: '', via: 'error', error: chrome.runtime.lastError.message });
      }
      resolve(res || { url: '', via: 'error', error: 'no reply from service worker' });
    });
  });
}

/* -------------------------------------------------------- hltv extra pages */

// td.location holds "Paris, France" or "Europe (Online)" plus the country flag.
// The same page lists every attending team with its flag, which is how the next
// opponent from the Liquipedia bracket gets one.
function readEventPage(doc) {
  var locTd = doc.querySelector('td.location');
  var setting = null;
  if (locTd) {
    var img = locTd.querySelector('img');
    setting = {
      place: locTd.textContent.replace(/\s+/g, ' ').trim()
        .replace(/\s*\((?:Online|LAN)\)\s*$/i, '').split(',')[0].trim(),
      flag: ((img && img.getAttribute('src') || '').match(/\/flags\/[^/]*\/([A-Za-z_-]+)\./) || [])[1] || ''
    };
    setting.flag = setting.flag.toUpperCase();
  }

  // Liquipedia and HLTV disagree about org suffixes - the bracket says "FUT
  // Esports" where HLTV says "FUT" - so the directory is indexed on the name
  // with those suffixes stripped as well as verbatim.
  var directory = {};
  Array.prototype.forEach.call(doc.querySelectorAll('a[href*="/team/"]'), function (a) {
    var name = a.textContent.replace(/\s+/g, ' ').trim();
    if (!name || directory[name]) return;
    var prev = a.previousElementSibling;
    var img = (prev && prev.tagName === 'IMG' && /flags\//.test(prev.getAttribute('src') || ''))
      ? prev
      : (a.parentElement && a.parentElement.querySelector('img.flag'));
    if (!img || !/flags\//.test(img.getAttribute('src') || '')) return;
    directory[name] = {
      flag: ((img.getAttribute('src').match(/\/flags\/[^/]*\/([A-Za-z_-]+)\./) || [])[1] || '').toUpperCase(),
      url: a.getAttribute('href')
    };
  });
  return { setting: setting, directory: directory };
}

var ORG_WORDS = ['esports', 'esport', 'gaming', 'team', 'club'];

// "FUT Esports" and "FUT" are the same org; so are "Team Vitality" and
// "Vitality". Comparing on the significant words only lets the two spellings
// meet. Splitting into words first means a standalone "Esports" is dropped
// while a name that merely contains those letters is left alone.
function orgKey(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (w) { return w && ORG_WORDS.indexOf(w) < 0; })
    .join('');
}

// Find a team in the HLTV event directory by a name that may carry a different
// org suffix. Returns { name, flag, url } using HLTV's own spelling.
function lookupTeam(directory, name) {
  if (!directory) return null;
  if (directory[name]) return Object.assign({ name: name }, directory[name]);
  var want = orgKey(name);
  if (!want) return null;
  var names = Object.keys(directory);
  for (var i = 0; i < names.length; i++) {
    if (orgKey(names[i]) === want) return Object.assign({ name: names[i] }, directory[names[i]]);
  }
  return null;
}

/* ------------------------------------------------------------------- panel */

var panel = null;

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
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

// selftext=true opens old.reddit's text-post tab; the flair rides in the hash so
// it never reaches the server or the posted URL.
function submitUrl(title, subreddit, flair) {
  return 'https://old.reddit.com/r/' + encodeURIComponent(subreddit) +
    '/submit?selftext=true&title=' + encodeURIComponent(title) +
    (flair ? '#pmt-flair=' + encodeURIComponent(flair) : '');
}

function field(parent, id, label, placeholder) {
  parent.appendChild(el('label', 'pmt-label', label));
  var i = el('input', 'pmt-input');
  i.id = id;
  if (placeholder) i.placeholder = placeholder;
  parent.appendChild(i);
  return i;
}

function buildPanel() {
  panel = el('div', 'pmt-panel');

  var head = el('div', 'pmt-head');
  head.appendChild(el('span', 'pmt-title-label', 'Post-Match Thread'));
  var close = el('button', 'pmt-x', '×');
  close.addEventListener('click', function () { panel.classList.remove('pmt-open'); });
  head.appendChild(close);
  panel.appendChild(head);

  field(panel, 'pmt-title', 'Thread title');

  panel.appendChild(el('div', 'pmt-label',
    'Liquipedia pages (found by search, remembered per team - clear one and Regenerate to search for it again)'));
  var lp = el('div', 'pmt-lp');
  ['pmt-lp-event', 'pmt-lp-t1', 'pmt-lp-t2'].forEach(function (id, i) {
    var input = el('input', 'pmt-input');
    input.id = id;
    input.placeholder = ['event', 'team 1', 'team 2'][i] + ' - https://liquipedia.net/counterstrike/…';
    lp.appendChild(input);
  });
  panel.appendChild(lp);

  panel.appendChild(el('label', 'pmt-label', 'Highlights (one per line: Title | url)'));
  var hl = el('textarea', 'pmt-hl');
  hl.id = 'pmt-hl';
  hl.rows = 3;
  panel.appendChild(hl);

  panel.appendChild(el('label', 'pmt-label', 'Body (markdown)'));
  var body = el('textarea', 'pmt-body');
  body.id = 'pmt-body';
  panel.appendChild(body);

  var row = el('div', 'pmt-row');
  var regen = el('button', 'pmt-btn', 'Regenerate');
  regen.addEventListener('click', function () { generate({ noOpen: true, fromPanel: true }); });
  var copy = el('button', 'pmt-btn pmt-primary', 'Copy body');
  copy.addEventListener('click', function () {
    copyText(document.getElementById('pmt-body').value)
      .then(function () { status('Copied to clipboard.'); })
      .catch(function () { status('Copy failed - select the text and press Ctrl+C.', true); });
  });
  var diag = el('button', 'pmt-btn', 'Copy diagnostics');
  diag.id = 'pmt-diag';
  diag.title = 'Copy this run\'s log - paste it when reporting a problem';
  diag.addEventListener('click', function () {
    copyText(PMTLog.text())
      .then(function () { status('Diagnostics copied - paste them into the bug report.'); })
      .catch(function () { status('Could not copy; the log is also in the devtools console.', true); });
  });
  var open = el('button', 'pmt-btn', 'Open reddit submit');
  open.addEventListener('click', function () {
    getSettings().then(function (s) {
      chrome.runtime.sendMessage({
        type: 'openTab',
        url: submitUrl(document.getElementById('pmt-title').value, s.subreddit, s.flair)
      });
    });
  });
  row.appendChild(regen);
  row.appendChild(copy);
  row.appendChild(open);
  row.appendChild(diag);
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

// Make the Copy diagnostics button shout when the run logged anything bad, so a
// partial thread is noticed before it is posted rather than after.
function refreshDiagnostics() {
  var btn = document.getElementById('pmt-diag');
  if (!btn) return;
  var c = PMTLog.counts();
  var bad = c.error + c.warn;
  btn.textContent = bad ? 'Copy diagnostics (' + bad + ')' : 'Copy diagnostics';
  btn.className = 'pmt-btn' + (c.error ? ' pmt-alert' : bad ? ' pmt-warn' : '');
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
  PMTLog.start(location.href);
  status('Reading match page…');

  var d;
  try {
    d = scrapeMatch(document, location.href);
  } catch (e) {
    PMTLog.error('scrapeMatch threw', e);
    busy = false;
    PMTLog.save();
    return status('Could not read the match page: ' + e.message, true);
  }
  PMTLog.info('match page parsed', {
    teams: d.teams.map(function (t) { return t.name + ' (' + t.flag + ') ' + t.score; }),
    event: d.event.name, eventUrl: d.event.url, prize: d.prize, venue: d.format.venue,
    stage: d.format.stage, veto: d.veto.length,
    maps: d.maps.map(function (m) { return m.name + (m.played ? ' ' + m.score.join('-') + (m.hasOt ? ' OT' : '') : ' (unplayed)'); }),
    statsAll: !!d.statsAll, vrs: !!d.vrs,
    roles: d.roles, highlights: d.highlights.length
  });
  if (!d.teams[0] || !d.teams[0].name) {
    busy = false;
    PMTLog.save();
    return status('This does not look like a finished match page.', true);
  }

  var hlBox = document.getElementById('pmt-hl');
  if (!hlBox.value && d.highlights.length) {
    hlBox.value = d.highlights.map(function (h) { return h.title + ' | ' + h.url; }).join('\n');
    hlBox.dataset.pristine = hlBox.value;
  }
  // While the box is untouched HLTV's own text is used verbatim; a round-trip
  // through the textarea would normalise away its double and trailing spaces.
  var highlights = hlBox.value === hlBox.dataset.pristine ? null : parseHighlights(hlBox.value);

  var overrides = {
    event: document.getElementById('pmt-lp-event').value.trim(),
    t1: document.getElementById('pmt-lp-t1').value.trim(),
    t2: document.getElementById('pmt-lp-t2').value.trim()
  };

  // An empty box only means "forget this one" when the panel had already filled
  // it in - on the first run they are all empty because nothing has run yet.
  var forget = {
    event: !!opts.fromPanel && !overrides.event,
    t1: !!opts.fromPanel && !overrides.t1,
    t2: !!opts.fromPanel && !overrides.t2
  };

  var notes = [];
  var soft = function (label) {
    return function (e) {
      PMTLog.error(label, e);
      notes.push(label + ' (' + (e.message || e) + ')');
      return null;
    };
  };

  status('Fetching event, Liquipedia and overtime details…');

  var eventPage = d.event.url
    ? fetchDoc(d.event.url, 'hltv event').then(function (r) {
        var ev = readEventPage(r.doc);
        PMTLog.info('hltv event parsed', {
          setting: ev.setting, teamsInDirectory: Object.keys(ev.directory).length
        });
        if (!ev.setting) PMTLog.warn('hltv event page had no td.location - Setting line will be omitted');
        return ev;
      }).catch(soft('HLTV event page'))
    : Promise.resolve(null);

  var lpEvent = liquipediaUrlFor('event', d.event.url, d.event.name, overrides.event, forget.event)
    .then(function (url) {
      if (!url) { notes.push('no Liquipedia event page found'); return null; }
      return fetchDoc(url, 'liquipedia event').then(function (r) {
        var kind = liquipediaPageKind(r.doc);
        // an event that resolved to a team page would put that team's streams
        // and a bracket that is not this one into the thread; as with teams,
        // the page has to prove what it is rather than just fail to look wrong
        if (kind !== 'tournament') {
          PMTLog.warn('liquipedia event page is not a tournament page', {
            url: url, kind: kind, title: lpPageTitle(r.doc), categories: pageCategories(r.doc).slice(0, 6)
          });
          notes.push('Liquipedia event link was ' + describeKind(kind) +
                     ' (' + (lpPageTitle(r.doc) || url) + '), ignored');
          return cacheForget(liquipediaCacheKey('event', d.event.url)).then(function () { return null; });
        }
        return { url: url, doc: r.doc };
      });
    }).catch(soft('Liquipedia event'));

  var lpTeams = [0, 1].map(function (i) {
    var name = d.teams[i].name;
    return liquipediaUrlFor('team', d.teams[i].urlPlain, name, overrides[i ? 't2' : 't1'],
                            forget[i ? 't2' : 't1'])
      .then(function (url) {
        if (!url) {
          notes.push('no Liquipedia page for ' + name);
          return null;
        }
        return fetchDoc(url, 'liquipedia team ' + name).then(function (r) {
          /*
           * Is this actually a team? A tournament page has an infobox with a
           * name and socials in it, so it parses cleanly into a team that never
           * existed - `Bebop` once came back as European Pro League Series 6
           * Play-In, and the thread listed the tournament's Twitter as the
           * team's. Better to print the HLTV name alone and say why.
           *
           * The page has to *prove* it is a team, rather than merely fail to
           * look like something else. Letting an unrecognised page through was
           * the more cautious-sounding rule and the wrong one: it let
           * `/counterstrike/Qualifier_Tournaments`, an index page with no
           * infobox and no roster on it, print as a team called "Qualifier
           * Tournaments". Nothing is lost by insisting - a page carrying
           * neither a team infobox nor a squad table has nothing to contribute
           * anyway, so rejecting it costs exactly the name it would have got
           * wrong.
           */
          var kind = liquipediaPageKind(r.doc);
          if (kind !== 'team') {
            PMTLog.warn('liquipedia page for ' + name + ' is not a team page', {
              url: url, kind: kind, title: lpPageTitle(r.doc),
              categories: pageCategories(r.doc).slice(0, 6)
            });
            notes.push('Liquipedia link for ' + name + ' was ' + describeKind(kind) +
                       ' (' + (lpPageTitle(r.doc) || url) + '), ignored');
            // do not remember it, or every future run repeats the mistake
            return cacheForget(liquipediaCacheKey('team', d.teams[i].urlPlain))
              .then(function () { return null; });
          }
          var parsed = parseTeamPage(r.doc, url);
          PMTLog.info('liquipedia team parsed ' + name, teamSummary(parsed));
          if (parsed.links.blocked.length) {
            PMTLog.info('links dropped for ' + name + ' - reddit autoremoves these', {
              dropped: parsed.links.blocked
            });
          }
          if (!parsed.roster.length) {
            PMTLog.warn('liquipedia team ' + name + ' has no roster', {
              url: url,
              squadTables: r.doc.querySelectorAll('.table2__table').length,
              infobox: !!r.doc.querySelector('.fo-nttax-infobox'),
              headings: Array.prototype.map.call(r.doc.querySelectorAll('h2,h3'), function (h) {
                return h.textContent.replace(/\s+/g, ' ').trim().slice(0, 24);
              }).slice(0, 12)
            });
            notes.push(name + ' roster empty');
          }
          return parsed;
        });
      }).catch(soft('Liquipedia ' + name));
  });

  // Only overtime maps need their stats page read.
  var otMaps = d.maps.filter(function (m) { return m.played && m.hasOt && m.statsUrl; });
  PMTLog.info('overtime maps to fetch', otMaps.map(function (m) { return m.name; }));
  var overtimePages = Promise.all(otMaps.map(function (m) {
    return fetchDoc(m.statsUrl, 'mapstats ' + m.name)
      .then(function (r) {
        var ot = scrapeOvertimes(r.doc);
        PMTLog.info('overtime parsed ' + m.name, {
          periods: ot.length,
          rows: r.doc.querySelectorAll('.round-history-team-row').length,
          detail: ot.map(function (pair) {
            return pair.map(function (x) {
              return x.team + ' ' + x.halves.map(function (h) { return h.side + ':' + h.rounds; }).join('/');
            });
          })
        });
        if (!ot.length) notes.push('no overtime rows for ' + m.name);
        return { id: m.mapstatsId, ot: ot };
      })
      .catch(soft('overtime for ' + m.name));
  }));

  Promise.all([getSettings(), eventPage, lpEvent, lpTeams[0], lpTeams[1], overtimePages])
    .then(function (r) {
      var settings = r[0], ev = r[1], lpe = r[2], lp1 = r[3], lp2 = r[4], ots = r[5];

      var overtimes = {};
      (ots || []).forEach(function (o) {
        if (!o || !o.ot.length) return;
        // put the rows in page order: row 0 must be team 1
        overtimes[o.id] = o.ot.map(function (pair) {
          return pair[0].team && pair[0].team.toLowerCase() === d.teams[1].name.toLowerCase()
            ? [pair[1], pair[0]] : pair;
        });
      });

      var next = null;
      if (lpe) {
        var names = [[d.teams[0].name, lp1 && lp1.name], [d.teams[1].name, lp2 && lp2.name]];
        var scores = [String(d.teams[0].score), String(d.teams[1].score)];
        next = nextRound(lpe.doc, names, scores);
        PMTLog.info('bracket lookup', {
          searchedFor: names, scores: scores, brackets: lpe.doc.querySelectorAll('.brkts-bracket').length,
          matches: lpe.doc.querySelectorAll('.brkts-match').length, result: next
        });
      }

      var opponentTag = '';
      if (next) {
        var opp = lookupTeam(ev && ev.directory, next.opponent);
        if (opp) {
          // HLTV's spelling is the one the subreddit flair table is keyed on
          opponentTag = '[' + flagEmoji(opp.flag) + '](' +
            teamAnchor(opp.name, opp.flag, settings.logoOverrides) + ')';
          if (opp.name !== next.opponent) {
            PMTLog.info('next opponent matched under a different name',
              { liquipedia: next.opponent, hltv: opp.name });
          }
        } else {
          PMTLog.warn('next opponent not in the HLTV event directory - rendering without a flag', {
            opponent: next.opponent,
            directorySample: ev ? Object.keys(ev.directory).slice(0, 12) : null
          });
        }
      }

      PMTLog.info('liquipedia summary', {
        event: lpe && lpe.url,
        streams: lpe ? parseStreams(lpe.doc).length : 0,
        team1: teamSummary(lp1), team2: teamSummary(lp2)
      });
      if (!lp1 || !lp2) {
        PMTLog.warn('team information will be incomplete', { team1: !!lp1, team2: !!lp2 });
      }

      document.getElementById('pmt-lp-event').value = (lpe && lpe.url) || '';
      document.getElementById('pmt-lp-t1').value = (lp1 && lp1.url) || '';
      document.getElementById('pmt-lp-t2').value = (lp2 && lp2.url) || '';

      var out = buildThread(d, {
        lp: [lp1, lp2],
        lpEventUrl: lpe && lpe.url,
        streams: lpe ? parseStreams(lpe.doc) : [],
        next: next,
        opponentTag: opponentTag,
        setting: ev && ev.setting,
        overtimes: overtimes,
        highlights: highlights,
        logoOverrides: settings.logoOverrides
      });

      document.getElementById('pmt-title').value = out.title;
      document.getElementById('pmt-body').value = out.body;
      if (!next) notes.push('no bracket entry - "advances to" line omitted');
      PMTLog.info('rendered', { titleLength: out.title.length, bodyLength: out.body.length, notes: notes });

      return copyText(out.body)
        .then(function () { return 'Body copied.'; })
        .catch(function () { return 'Copy blocked - use the Copy body button.'; })
        .then(function (msg) {
          status(msg + (notes.length ? ' Missing: ' + notes.join('; ') + '.' : ''),
                 /blocked/.test(msg));
          if (settings.autoOpen && !opts.noOpen) {
            chrome.runtime.sendMessage({
              type: 'openTab',
              url: submitUrl(out.title, settings.subreddit, settings.flair)
            });
          }
        });
    })
    .catch(function (e) {
      PMTLog.error('generate failed', e);
      status('Failed: ' + (e.message || e), true);
    })
    .then(function () {
      busy = false;
      PMTLog.info('run finished', PMTLog.counts());
      PMTLog.save();
      refreshDiagnostics();
    });
}

/* -------------------------------------------------------------- entrypoint */

if (document.querySelector('.teamsBox') && !document.querySelector('.pmt-launch')) {
  var btn = el('button', 'pmt-launch', 'Post-Match Thread');
  btn.title = 'Generate the r/GlobalOffensive post-match thread';
  btn.addEventListener('click', function () { generate(); });
  document.body.appendChild(btn);
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'generate') generate();
});
