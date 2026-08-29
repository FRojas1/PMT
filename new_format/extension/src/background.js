/*
 * background.js - all off-site work happens in a real background tab.
 *
 * Both sources actively refuse a service-worker fetch:
 *   Liquipedia  403 + "Verify you are human" unless its clearance cookie rides
 *               along (same URL, same instant: with cookies 200/380KB, without
 *               403/2059 bytes)
 *   Search      a captcha a fetch can never solve - Brave answers 429 with
 *               "your browser does not seem to have JavaScript enabled", Google
 *               redirects to /sorry/
 *
 * A tab is a real browser: it has the cookies, it runs the JavaScript, and it
 * looks like the user because it is the user. So searches are performed by
 * navigating a background tab, and page contents are read from inside it. One
 * tab is opened lazily, shared across a run, and closed once the run has been
 * idle for a few seconds; if the user already has a Liquipedia tab open, that
 * one is borrowed and left alone. The idle delay is load-bearing: tab work is
 * serialised, so the outstanding-operation count hits zero between every fetch,
 * and closing at that instant races the next acquire against tabs.remove. The
 * dying tab still matches `liquipedia.net/*`, the next read inherits its id,
 * and twenty seconds later extractHtml dies with "No tab with id".
 *
 * The only fetch still attempted directly is a Liquipedia page - it is much
 * faster when the cookie happens to travel, and it falls back to the tab the
 * moment anything at all comes back that is not the article. A Liquipedia read
 * therefore escalates through three rungs, stopping at the first that returns
 * a real page:
 *
 *   worker fetch    fastest, works only when the clearance cookie travels
 *   tab fetch       same-origin, from inside the tab, with its cookies
 *   tab navigation  the tab simply goes to the page, exactly as the user would
 *
 * The escalation is deliberately blind to *why* the previous rung failed,
 * because the failure modes do not look alike: a Cloudflare challenge is a 403
 * with a captcha in it, a school or office web filter is often a 200 serving
 * its own "blocked" page, and a DNS blackhole is no response at all - the fetch
 * simply throws. Each of those used to end the read; each of them now drops to
 * the next rung, and the reason it did is recorded in the run log.
 */

var DIAGNOSTIC_HEADERS = ['server', 'retry-after', 'cf-ray', 'cf-mitigated', 'x-cache', 'content-type'];
var SEARCH_SPACING_MS = 1200;    // don't machine-gun the search engine

function isChallenge(status, text) {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  return /verify you are human|are you a robot|captcha|checking your browser|javascript enabled/i.test(text || '');
}

function isLiquipediaUrl(url) {
  return /^https:\/\/liquipedia\.net\//.test(url || '');
}

/*
 * Did that response actually contain the article?
 *
 * A blocked page does not have to arrive with an error status: web filters,
 * captive portals and transparent proxies all answer 200 with their own HTML,
 * and that HTML parses perfectly well - into a thread with an empty roster in
 * it. So the body is checked rather than the status, and checked for what a
 * Liquipedia page *has* rather than for what a block page says: every article
 * is MediaWiki output, while a blocklist of filter vendors' wording would both
 * miss the next filter and fire on an article that merely quotes one.
 */
var MEDIAWIKI_MARKERS = /mw-parser-output|firstHeading|mw-body-content|wgPageName/;

function isRealPage(url, text) {
  if (!text) return false;
  return isLiquipediaUrl(url) ? MEDIAWIKI_MARKERS.test(text) : true;
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
var tabUsers = 0;        // outstanding operations
var closeTimer = null;
var TAB_IDLE_MS = 10000; // close our tab once the run has gone quiet
var queue = Promise.resolve();
var lastSearchAt = 0;

function isMissingTabError(e) {
  return /No tab with id/i.test(String((e && e.message) || e || ''));
}

// Everything that touches the tab is serialised: one navigation at a time, and
// searches spaced out so they look like a person typing rather than a script.
function enqueue(fn) {
  var run = queue.then(fn, fn);
  queue = run.catch(function () {});
  return run;
}

function forgetTab(id) {
  if (tab && (id == null || tab.id === id)) tab = null;
}

chrome.tabs.onRemoved.addListener(function (id) { forgetTab(id); });

function tabStillOpen(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.get(tabId, function (t) {
      resolve(!chrome.runtime.lastError && !!t);
    });
  });
}

function createOurTab(resolve, reject) {
  chrome.tabs.create({ url: 'about:blank', active: false }, function (created) {
    if (chrome.runtime.lastError || !created) {
      return reject(new Error(chrome.runtime.lastError
        ? chrome.runtime.lastError.message
        : 'could not open a background tab'));
    }
    tab = { id: created.id, ours: true };
    resolve(tab);
  });
}

function openOrBorrowTab() {
  return new Promise(function (resolve, reject) {
    chrome.tabs.query({ url: 'https://liquipedia.net/*' }, function (tabs) {
      if (tabs && tabs.length) {
        // a just-closed tab still matches this query for a moment; using that
        // id is how a team read died with "No tab with id" after the event
        // page had already been read and the shared tab torn down
        return tabStillOpen(tabs[0].id).then(function (open) {
          if (open) {
            tab = { id: tabs[0].id, ours: false };
            return resolve(tab);
          }
          createOurTab(resolve, reject);
        });
      }
      createOurTab(resolve, reject);
    });
  });
}

function acquireTab() {
  tabUsers++;
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (tab) {
    return tabStillOpen(tab.id).then(function (open) {
      if (open) return tab;
      tab = null;
      return openOrBorrowTab();
    });
  }
  return openOrBorrowTab();
}

function releaseTab() {
  tabUsers--;
  if (tabUsers > 0 || !tab) return;
  // Do not close here. The queue runs one fetch at a time, so this count is
  // zero between the event page and each team page; closing then hands the
  // next read a dying id. Keep the handle (and the clearance cookie the tab
  // just earned) and only tear our tab down once the run has gone idle.
  if (!tab.ours) return;
  closeTimer = setTimeout(function () {
    closeTimer = null;
    if (tabUsers > 0 || !tab || !tab.ours) return;
    var id = tab.id;
    chrome.tabs.remove(id, function () {
      void chrome.runtime.lastError;
      forgetTab(id);
    });
  }, TAB_IDLE_MS);
}

function runWithTab(work) {
  return acquireTab()
    .then(work)
    .then(function (res) { releaseTab(); return res; },
          function (e) { releaseTab(); throw e; });
}

// Navigate and wait for the *new* load to finish. The previous helper treated
// the tab's current "complete" as success, which is the page we are leaving
// whenever the shared tab is reused.
function navigate(tabId, url) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var seenLoading = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    }
    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') seenLoading = true;
      if (info.status === 'complete' && seenLoading) finish();
    }
    function onRemoved(id) {
      if (id === tabId) finish(new Error('No tab with id: ' + tabId));
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    var timer = setTimeout(function () { finish(); }, 20000);
    chrome.tabs.update(tabId, { url: url }, function (t) {
      if (chrome.runtime.lastError) {
        return finish(new Error(chrome.runtime.lastError.message));
      }
      if (t && t.status === 'loading') seenLoading = true;
      // already on this URL (or the update was a no-op): nothing will load
      if (t && t.status === 'complete' && samePage(t.url, url)) finish();
    });
  });
}

function samePage(actual, wanted) {
  if (!actual || !wanted) return false;
  try {
    return new URL(actual).href === new URL(wanted).href;
  } catch (e) {
    return actual === wanted;
  }
}

function runInTab(tabId, func, args) {
  return chrome.scripting.executeScript({ target: { tabId: tabId }, func: func, args: args || [] })
    .then(function (frames) {
      if (!frames || !frames[0]) throw new Error('no result from tab');
      return frames[0].result;
    });
}

function tabOrigin(tabId) {
  return runInTab(tabId, function () { return location.origin; }).catch(function (e) {
    if (isMissingTabError(e)) throw e;
    return '';
  });
}

/* --------------------------------------------------------------- extractors
 * These run inside the tab, so they see the page after its JavaScript has run.
 */

/*
 * Every link in the results column, in the order the page lists them.
 *
 * Deliberately not a result parser. Picking apart a SERP means naming the
 * classes its results are built from, and Google's are generated - `.PMDqCb`,
 * `.NMq1me`, different next month. But this only ever needs *one* link, so the
 * markup can be ignored entirely: collect every anchor and let the caller keep
 * the first that points at a Counter-Strike article. That rule is identical on
 * both engines, which is why one extractor serves both.
 *
 * Scoped to the results column because a SERP has links elsewhere - ads, "people
 * also ask", and on one saved Google page an invisible zero-text anchor sitting
 * outside #rso. These container ids are the stable part of Google's markup;
 * Brave has none of them and falls through to the body, as it always did.
 */
function extractResultLinks() {
  var root = document.querySelector('#rso') || document.querySelector('#search') ||
             document.querySelector('#center_col') || document.querySelector('#results') ||
             document.body;
  var hrefs = [];
  if (root) {
    Array.prototype.forEach.call(root.querySelectorAll('a[href]'), function (a) {
      if (a.href) hrefs.push(a.href);
    });
  }
  return {
    url: location.href,
    title: document.title,
    hrefs: hrefs,
    bodyExcerpt: (document.body ? document.body.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 400)
  };
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
 * Searching is done in the tab, Google first and Brave behind it.
 *
 * Liquipedia's own search is not usable for this: its "go" jump resolves
 * `Vitality` to Team_Vitality but resolves `Spirit` to the *player* page
 * `/counterstrike/Spirit`, and its results ranking put FaZe Clan first for
 * "IEM Beijing 2026 Open Qualifier". Wrong-but-plausible is the worst failure
 * mode here, because the thread still renders - just with another team's roster
 * in it.
 *
 * Brave is right about the teams everyone has heard of and gets steadily worse
 * as they get smaller, which is the wrong way round: an obscure org is exactly
 * the one nobody proofreading the thread will catch. Google answered the
 * obscure cases correctly - `yawara` -> Yawara_E-Sports, `FOKUS` -> FOKUS - so
 * it goes first. Brave stays as the fallback rather than being deleted, because
 * Google is the stricter of the two about automation and a captcha there must
 * not take the whole run down with it.
 */
var SEARCH_ENGINES = [
  { name: 'google', url: function (q) { return 'https://www.google.com/search?q=' + encodeURIComponent(q); } },
  { name: 'brave', url: function (q) { return 'https://search.brave.com/search?q=' + encodeURIComponent(q) + '&source=web'; } }
];

function searchQueryFor(name) {
  return name + ' counterstrike liquipedia';
}

/*
 * Wiki plumbing, which a search will happily return alongside the articles -
 * the saved FOKUS results carry a `Template:Team_Vitality_Roster_Navbox` link.
 * Listed by name rather than excluding anything with a colon in it, because a
 * real article is allowed one: `Counter-Strike:_Global_Offensive`.
 */
var MEDIAWIKI_NAMESPACE =
  /^(Category|Template|File|Image|Help|Special|User|Talk|Portal|Liquipedia|MediaWiki|Module|Property|Form|Concept|Data|Widget)(_talk)?:/i;

function isCounterstrikeArticle(href) {
  var m = /^https:\/\/liquipedia\.net\/counterstrike\/([^?#]+)$/.exec(href || '');
  if (!m) return false;
  return !MEDIAWIKI_NAMESPACE.test(m[1]) &&
    !/\/Main_Page$/.test(href) &&
    !/\/index\.php/.test(href);
}

// Both engines sometimes route a result through their own redirector.
function unwrapRedirect(href) {
  var m = /^https?:\/\/(?:www\.)?(?:google\.[^/]+|search\.brave\.com)\/url\?(.*)$/.exec(href || '');
  if (!m) return href;
  try {
    var p = new URLSearchParams(m[1]);
    return p.get('q') || p.get('url') || href;
  } catch (e) {
    return href;
  }
}

// A team's Matches and Results tabs are separate pages and Google ranks them as
// separate results, so "FOKUS/Results" can outrank "FOKUS". They are the same
// article one level down; the parent is the one with the roster on it. Event
// pages are nested too (Esports_World_Cup/2026), hence naming the tabs rather
// than treating any trailing path segment as a subpage.
var LIQUIPEDIA_SUBPAGE =
  /\/(Matches|Results|Statistics|Achievements|Additional_Content|Played_Matches)(\/[A-Za-z0-9_]+)?$/;

/*
 * A team lives at a single path segment - Team_Spirit, K27, FOKUS,
 * Yawara_E-Sports - while tournaments nest: European_Pro_League/Series_6/Play-In,
 * Fiesta_Series/1, Esports_World_Cup/2026. So when a *team* is being looked for,
 * a nested article is passed over in favour of a flat one further down the
 * results. That is a preference and not a filter: if nothing flat turns up, the
 * best candidate is still returned and the page it lands on gets checked before
 * anything is built from it. This is what stops `Bebop` settling for the first
 * plausible-looking tournament link on the page.
 */
function articleSegments(href) {
  return href.replace(/^https:\/\/liquipedia\.net\/counterstrike\//, '').split('/').length;
}

function pickResult(hrefs, kind) {
  var candidates = [];
  for (var i = 0; i < hrefs.length; i++) {
    var href = unwrapRedirect(hrefs[i]).split('#')[0];
    if (isCounterstrikeArticle(href)) {
      href = href.replace(LIQUIPEDIA_SUBPAGE, '');
      if (candidates.indexOf(href) < 0) candidates.push(href);
    }
  }
  if (kind === 'team') {
    for (var c = 0; c < candidates.length; c++) {
      if (articleSegments(candidates[c]) === 1) return candidates[c];
    }
  }
  return candidates[0] || '';
}

/*
 * Did the engine answer, or did it stop us at the door?
 *
 * Worth telling apart from "no results": a captcha means try the other engine,
 * while a genuine miss means this name is not going to be found by asking the
 * same question twice. Google sends a challenge to /sorry/ and EU consent to
 * consent.google.com, and the tab's own URL gives that away without needing
 * permission to run code on those origins - which is just as well, since it
 * will not grant it.
 */
function looksBlocked(landedUrl, page) {
  if (/\/sorry\/|consent\.google\.|\/challenge/i.test(landedUrl || '')) return true;
  var text = (page && page.bodyExcerpt) || '';
  return /unusual traffic|are you a robot|not a robot|before you continue|enable javascript|captcha/i.test(text);
}

function tabUrl(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.get(tabId, function (t) {
      resolve((!chrome.runtime.lastError && t && t.url) || '');
    });
  });
}

function spaceOutSearches() {
  var wait = Math.max(0, SEARCH_SPACING_MS - (Date.now() - lastSearchAt));
  lastSearchAt = Date.now() + wait;
  return new Promise(function (r) { setTimeout(r, wait); });
}

// One engine: navigate, read the links, keep the first article. Never rejects -
// a failed engine is a step in the trace, and the next one still gets its turn.
function askEngine(tabId, engine, query, kind, trace) {
  return spaceOutSearches()
    .then(function () { return navigate(tabId, engine.url(query)); })
    .then(function () { return tabUrl(tabId); })
    .then(function (landed) {
      // a challenge page is a different origin, and injection there is refused
      return runInTab(tabId, extractResultLinks).then(
        function (page) { return { landed: landed, page: page }; },
        function (e) {
          if (isMissingTabError(e)) throw e;
          return { landed: landed, page: null, error: String(e.message || e) };
        }
      );
    })
    .then(function (got) {
      var page = got.page;
      var url = page ? pickResult(page.hrefs, kind) : '';
      var blocked = looksBlocked(got.landed || (page && page.url), page);
      trace.push({
        step: engine.name,
        title: page ? page.title : undefined,
        links: page ? page.hrefs.length : 0,
        blocked: blocked || undefined,
        error: got.error,
        // when nothing came back, the page itself usually says why
        excerpt: url ? undefined : (page ? page.bodyExcerpt : undefined)
      });
      return url;
    }, function (e) {
      if (isMissingTabError(e)) throw e;
      trace.push({ step: engine.name, error: String(e.message || e) });
      return '';
    });
}

function searchEngines(tabId, query, kind, trace) {
  // each engine in turn, stopping at the first that answers - a second
  // engine is only ever asked when the first came back empty or blocked
  return SEARCH_ENGINES.reduce(function (chain, engine) {
    return chain.then(function (found) {
      if (found && found.url) return found;
      return askEngine(tabId, engine, query, kind, trace).then(function (url) {
        return { url: url, via: engine.name + '-tab' };
      });
    });
  }, Promise.resolve(null));
}

function searchInTab(kind, name) {
  var query = searchQueryFor(name);
  var trace = [];
  return enqueue(function () {
    return runWithTab(function (t) { return searchEngines(t.id, query, kind, trace); })
      .catch(function (e) {
        if (!isMissingTabError(e)) throw e;
        forgetTab();
        return runWithTab(function (t) { return searchEngines(t.id, query, kind, trace); });
      })
      .then(function (res) {
        return { url: res.url, via: res.url ? res.via : 'none', trace: trace };
      }, function (e) {
        return { url: '', via: 'error', error: String(e.message || e), trace: trace };
      });
  });
}

// Read a Liquipedia page. Tries a plain credentialed fetch first because it is
// far quicker, and drops to the tab whenever that does not come back with the
// article - a challenge, a filter's block page, or no response at all.
function fetchPage(url) {
  var t0 = Date.now();
  return fetch(url, { credentials: 'include' })
    .then(function (r) {
      return r.text().then(function (text) { return { response: r, text: text }; });
    })
    .then(function (got) {
      var r = got.response, text = got.text;
      if (r.ok && isRealPage(url, text)) {
        return { ok: true, status: r.status, url: r.url, text: text,
                 bytes: text.length, ms: Date.now() - t0, via: 'worker',
                 contentType: r.headers.get('content-type') || '' };
      }
      var headers = {};
      DIAGNOSTIC_HEADERS.forEach(function (h) {
        var v = r.headers.get(h);
        if (v) headers[h] = v;
      });
      return retryInTab(url, {
        ok: false, status: r.status, statusText: r.statusText || '', url: r.url,
        bytes: text.length, ms: Date.now() - t0, via: 'worker', headers: headers,
        excerpt: excerptOf(text), challenge: isChallenge(r.status, text),
        // a 200 that was not the page asked for: something answered in its place
        intercepted: r.ok || undefined
      });
    }, function (e) {
      // No response at all - blocked at the network layer, offline, or DNS
      // sinkholed. The tab still gets its own try: whatever refused the worker
      // may well let a normal navigation through.
      return retryInTab(url, {
        ok: false, status: 0, url: url, via: 'worker', ms: Date.now() - t0,
        error: String((e && e.message) || e), networkError: true
      });
    });
}

// The tab is only worth waking for a Liquipedia page; anything else is reported
// as it failed.
function retryInTab(url, failed) {
  if (!isLiquipediaUrl(url)) return Promise.resolve(failed);
  return fetchPageInTab(url).then(function (viaTab) {
    viaTab.retriedAfter = {
      status: failed.status, bytes: failed.bytes, challenge: failed.challenge,
      intercepted: failed.intercepted, networkError: failed.networkError,
      error: failed.error, excerpt: failed.excerpt
    };
    return viaTab;
  });
}

// A fetch from inside the tab. Quicker than a navigation and the cookie is sent
// without question, but it is still a fetch, and a filter that blocks those on
// sight blocks this one too - so its answer is checked like any other.
function fetchInTab(tabId, url, t0) {
  return runInTab(tabId, sameOriginFetch, [url]).then(function (r) {
    var ok = r.ok && isRealPage(url, r.text);
    return { ok: ok, status: r.status, url: r.url, text: r.text,
             bytes: (r.text || '').length, ms: Date.now() - t0, via: 'tab-fetch',
             excerpt: ok ? undefined : excerptOf(r.text), error: r.error,
             intercepted: (r.ok && !ok) || undefined };
  });
}

function readViaTab(t, url, t0) {
  return tabOrigin(t.id).then(function (origin) {
    // already somewhere on liquipedia.net: try the cheap same-origin fetch
    // first, and navigate only if it comes back with something else
    var quick = origin === 'https://liquipedia.net'
      ? fetchInTab(t.id, url, t0).catch(function (e) {
          if (isMissingTabError(e)) throw e;
          return null;
        })
      : Promise.resolve(null);
    return quick.then(function (r) {
      if (r && r.ok) return r;
      return navigateInTab(t.id, url, t0).then(function (viaNav) {
        // `retriedAfter` belongs to the worker fetch that got us here, so
        // the rung skipped inside the tab is reported under its own name
        if (r) {
          viaNav.afterTabFetch = { status: r.status, bytes: r.bytes,
                                   intercepted: r.intercepted, error: r.error };
        }
        return viaNav;
      });
    });
  });
}

function tabFetchFailed(url, t0, e) {
  return { ok: false, status: 0, url: url, via: 'tab', ms: Date.now() - t0,
           error: String((e && e.message) || e) };
}

// The last rung: the tab goes to the page itself. Nothing here is a fetch, an
// XHR or an extension - it is a browser loading a URL, which is the request
// every one of these defences is built to let through.
function navigateInTab(tabId, url, t0) {
  return navigate(tabId, url)
    .then(function () { return runInTab(tabId, extractHtml); })
    .then(function (r) {
      var ok = isRealPage(url, r.html);
      return { ok: ok, status: ok ? 200 : 0, url: r.url, text: r.html,
               bytes: r.html.length, ms: Date.now() - t0, via: 'tab-navigate',
               // whatever loaded was not the article: say so rather than hand
               // back a block page that parses into an empty roster
               excerpt: ok ? undefined : excerptOf(r.html),
               intercepted: ok ? undefined : true };
    });
}

function fetchPageInTab(url) {
  var t0 = Date.now();
  return enqueue(function () {
    return runWithTab(function (t) { return readViaTab(t, url, t0); })
      .catch(function (e) {
        if (!isMissingTabError(e)) return tabFetchFailed(url, t0, e);
        // the tab we were using vanished (closed mid-flight, or we inherited
        // an id that was already gone). try once more with a fresh tab.
        forgetTab();
        return runWithTab(function (t) { return readViaTab(t, url, t0); })
          .catch(function (e2) { return tabFetchFailed(url, t0, e2); });
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
