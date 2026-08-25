/*
 * background.js - all off-site work happens in a real background tab.
 *
 * Both sources actively refuse a service-worker fetch:
 *   Liquipedia  403 + "Verify you are human" unless its clearance cookie rides
 *               along (same URL, same instant: with cookies 200/380KB, without
 *               403/2059 bytes)
 *   Brave       429 + "your browser does not seem to have JavaScript enabled" -
 *               a captcha a fetch can never solve
 *
 * A tab is a real browser: it has the cookies, it runs the JavaScript, and it
 * looks like the user because it is the user. So searches are performed by
 * navigating a background tab, and page contents are read from inside it. One
 * tab is opened lazily, shared across a run, and closed when the run goes idle;
 * if the user already has a Liquipedia tab open, that one is borrowed and left
 * alone.
 *
 * The only fetch still attempted directly is a Liquipedia page - it is much
 * faster when the cookie happens to travel, and it falls back to the tab the
 * moment a challenge comes back.
 */

var DIAGNOSTIC_HEADERS = ['server', 'retry-after', 'cf-ray', 'cf-mitigated', 'x-cache', 'content-type'];
var SEARCH_SPACING_MS = 1200;    // don't machine-gun the search engine

function isChallenge(status, text) {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  return /verify you are human|are you a robot|captcha|checking your browser|javascript enabled/i.test(text || '');
}

function excerptOf(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/* ------------------------------------------------------------- the tab */

var tab = null;          // { id, ours }
var tabUsers = 0;        // outstanding operations; the tab closes at zero
var queue = Promise.resolve();
var lastSearchAt = 0;

// Everything that touches the tab is serialised: one navigation at a time, and
// searches spaced out so they look like a person typing rather than a script.
function enqueue(fn) {
  var run = queue.then(fn, fn);
  queue = run.catch(function () {});
  return run;
}

function waitForComplete(tabId) {
  return new Promise(function (resolve) {
    var settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    }
    function onUpdated(id, info) { if (id === tabId && info.status === 'complete') finish(); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    var timer = setTimeout(finish, 20000);
    chrome.tabs.get(tabId, function (t) {
      if (!chrome.runtime.lastError && t && t.status === 'complete') finish();
    });
  });
}

function acquireTab() {
  tabUsers++;
  if (tab) return Promise.resolve(tab);
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: 'https://liquipedia.net/*' }, function (tabs) {
      if (tabs && tabs.length) { tab = { id: tabs[0].id, ours: false }; return resolve(tab); }
      chrome.tabs.create({ url: 'about:blank', active: false }, function (created) {
        tab = { id: created.id, ours: true };
        resolve(tab);
      });
    });
  });
}

function releaseTab() {
  tabUsers--;
  if (tabUsers > 0 || !tab) return;
  var t = tab;
  tab = null;
  if (t.ours) chrome.tabs.remove(t.id, function () { void chrome.runtime.lastError; });
}

function navigate(tabId, url) {
  return new Promise(function (resolve) {
    chrome.tabs.update(tabId, { url: url }, function () {
      void chrome.runtime.lastError;
      resolve();
    });
  }).then(function () { return waitForComplete(tabId); });
}

function runInTab(tabId, func, args) {
  return chrome.scripting.executeScript({ target: { tabId: tabId }, func: func, args: args || [] })
    .then(function (frames) {
      if (!frames || !frames[0]) throw new Error('no result from tab');
      return frames[0].result;
    });
}

function tabOrigin(tabId) {
  return runInTab(tabId, function () { return location.origin; }).catch(function () { return ''; });
}

/* --------------------------------------------------------------- extractors
 * These run inside the tab, so they see the page after its JavaScript has run.
 */

function extractSearchResults() {
  var out = { url: location.href, title: document.title, results: [] };
  // Brave's organic results
  Array.prototype.forEach.call(document.querySelectorAll('.result-content > a'), function (a) {
    if (a.href) out.results.push({ href: a.href, text: (a.textContent || '').trim().slice(0, 80) });
  });
  out.bodyExcerpt = (document.body ? document.body.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return out;
}

function extractHtml() {
  return { url: location.href, html: '<!doctype html>' + document.documentElement.outerHTML };
}

function sameOriginFetch(u) {
  return fetch(u, { credentials: 'include' })
    .then(function (r) {
      return r.text().then(function (t) {
        return { ok: r.ok, status: r.status, url: r.url, text: t };
      });
    })
    .catch(function (e) { return { ok: false, status: 0, url: u, error: String((e && e.message) || e) }; });
}

/* ----------------------------------------------------------------- actions */

/*
 * Searching is done with Brave, in the tab.
 *
 * Liquipedia's own search is not usable for this: its "go" jump resolves
 * `Vitality` to Team_Vitality but resolves `Spirit` to the *player* page
 * `/counterstrike/Spirit`, and its results ranking put FaZe Clan first for
 * "IEM Beijing 2026 Open Qualifier". Wrong-but-plausible is the worst failure
 * mode here, because the thread still renders - just with another team's roster
 * in it. Brave got every case right in testing, so Brave it is.
 */
function braveUrlFor(name) {
  return 'https://search.brave.com/search?q=' +
    encodeURIComponent(name + ' counterstrike liquipedia') + '&source=web';
}

function isCounterstrikeArticle(href) {
  return /^https:\/\/liquipedia\.net\/counterstrike\/[^?#]+$/.test(href) &&
    !/\/Main_Page$/.test(href) &&
    !/\/index\.php/.test(href);
}

function pickResult(results) {
  for (var i = 0; i < results.length; i++) {
    if (isCounterstrikeArticle(results[i].href)) return results[i].href.split('#')[0];
  }
  return '';
}

function spaceOutSearches() {
  var wait = Math.max(0, SEARCH_SPACING_MS - (Date.now() - lastSearchAt));
  lastSearchAt = Date.now() + wait;
  return new Promise(function (r) { setTimeout(r, wait); });
}

function searchInTab(kind, name) {
  var trace = [];
  return enqueue(function () {
    return acquireTab()
      .then(function (t) {
        return spaceOutSearches()
          .then(function () { return navigate(t.id, braveUrlFor(name)); })
          .then(function () { return runInTab(t.id, extractSearchResults); })
          .then(function (b) {
            var url = pickResult(b.results);
            trace.push({
              step: 'brave', title: b.title, results: b.results.length,
              // when nothing came back, the page itself says why
              excerpt: url ? undefined : b.bodyExcerpt,
              firstHrefs: url ? undefined : b.results.slice(0, 3).map(function (r) { return r.href; })
            });
            return { url: url, via: 'brave-tab', trace: trace };
          });
      })
      .then(function (res) { releaseTab(); return res; },
            function (e) {
              releaseTab();
              return { url: '', via: 'error', error: String(e.message || e), trace: trace };
            });
  });
}

// Read a Liquipedia page. Tries a plain credentialed fetch first because it is
// far quicker, and drops to the tab when the human check bites.
function fetchPage(url) {
  var t0 = Date.now();
  return fetch(url, { credentials: 'include' })
    .then(function (r) {
      return r.text().then(function (text) {
        if (r.ok) {
          return { ok: true, status: r.status, url: r.url, text: text,
                   bytes: text.length, ms: Date.now() - t0, via: 'worker',
                   contentType: r.headers.get('content-type') || '' };
        }
        var headers = {};
        DIAGNOSTIC_HEADERS.forEach(function (h) {
          var v = r.headers.get(h);
          if (v) headers[h] = v;
        });
        var failed = {
          ok: false, status: r.status, statusText: r.statusText || '', url: r.url,
          bytes: text.length, ms: Date.now() - t0, via: 'worker', headers: headers,
          excerpt: excerptOf(text), challenge: isChallenge(r.status, text)
        };
        if (!/^https:\/\/liquipedia\.net\//.test(url)) return failed;
        return fetchPageInTab(url).then(function (viaTab) {
          viaTab.retriedAfter = { status: failed.status, bytes: failed.bytes,
                                  challenge: failed.challenge };
          return viaTab;
        });
      });
    })
    .catch(function (e) {
      return { ok: false, status: 0, url: url, error: String(e.message || e), ms: Date.now() - t0 };
    });
}

function fetchPageInTab(url) {
  var t0 = Date.now();
  return enqueue(function () {
    return acquireTab().then(function (t) {
      return tabOrigin(t.id).then(function (origin) {
        // already somewhere on liquipedia.net: a same-origin fetch is quicker
        // than another navigation, and the cookie is sent without question
        if (origin === 'https://liquipedia.net') {
          return runInTab(t.id, sameOriginFetch, [url]).then(function (r) {
            return { ok: r.ok, status: r.status, url: r.url, text: r.text,
                     bytes: (r.text || '').length, ms: Date.now() - t0, via: 'tab-fetch',
                     excerpt: r.ok ? undefined : excerptOf(r.text), error: r.error };
          });
        }
        return navigate(t.id, url)
          .then(function () { return runInTab(t.id, extractHtml); })
          .then(function (r) {
            return { ok: true, status: 200, url: r.url, text: r.html,
                     bytes: r.html.length, ms: Date.now() - t0, via: 'tab-navigate' };
          });
      });
    }).then(function (res) { releaseTab(); return res; },
            function (e) {
              releaseTab();
              return { ok: false, status: 0, url: url, via: 'tab', ms: Date.now() - t0,
                       error: String(e.message || e) };
            });
  });
}

/* ---------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'openTab') {
    chrome.tabs.create({ url: msg.url, index: (sender.tab ? sender.tab.index + 1 : undefined) });
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'fetchText') {
    fetchPage(msg.url).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'search') {
    searchInTab(msg.kind, msg.name).then(sendResponse);
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener(function (tab) {
  if (tab && /^https:\/\/www\.hltv\.org\/matches\//.test(tab.url || '')) {
    chrome.tabs.sendMessage(tab.id, { type: 'generate' });
  }
});
