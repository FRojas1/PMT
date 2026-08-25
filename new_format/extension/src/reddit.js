/*
 * reddit.js - runs on old.reddit's submit page and picks the post flair.
 *
 * The flair name arrives in the URL hash (#pmt-flair=...) so it never reaches
 * the server or the submitted post's URL.
 *
 * Old reddit builds the flair control with its own JS after load, so this polls
 * until it appears. The known-good path is three clicks:
 *
 *   .flairselect-btn                                   open the picker
 *   .linkflair.linkflair-discussion.linkflair-esports  pick the flair
 *     > .linkflairlabel
 *   #newlink-flair-dropdown > form > button            apply it
 *
 * The steps after the first are fallbacks for when reddit's markup differs from
 * what this was written against. The apply step only ever clicks the configured
 * selector, and refuses if that button turns out to belong to the post's own
 * form - a stray click there would submit the thread before the body is pasted.
 */

(function () {
  var m = location.hash.match(/pmt-flair=([^&]*)/);
  if (!m) return;
  var wanted = decodeURIComponent(m[1]).trim();
  if (!wanted) return;

  var DEFAULT_SELECTOR = '.linkflair.linkflair-discussion.linkflair-esports > .linkflairlabel';
  var DEFAULT_APPLY = '#newlink-flair-dropdown > form > button';
  var OPEN_SELECTOR = '.flairselect-btn';
  var TIMEOUT = 10000;

  var settings = { flairSelector: DEFAULT_SELECTOR, flairApplySelector: DEFAULT_APPLY };
  var started = Date.now();
  var opened = false;
  var done = false;

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  var target = norm(wanted);

  function visible(n) {
    return !!(n && (n.offsetParent || n.offsetHeight || n.getClientRects().length));
  }

  function click(n) {
    n.click();
    // some builds wire the choice to a radio rather than the label's click handler
    var li = n.closest && n.closest('li');
    var radio = li && li.querySelector('input[type=radio]');
    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function toast(msg, ok) {
    var n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:8px 12px;' +
      'border-radius:4px;font:600 12px/1.3 Arial,sans-serif;color:#fff;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.3);background:' + (ok ? '#2d7d46' : '#8a6d3b');
    document.body.appendChild(n);
    setTimeout(function () { n.remove(); }, ok ? 3000 : 10000);
  }

  function finish(ok, how) {
    if (done) return;
    done = true;
    if (ok) {
      toast('Flair set: ' + wanted, true);
      console.info('[PMT] flair applied via ' + how);
    } else {
      toast('Could not set the "' + wanted + '" flair - set it by hand.', false);
      console.warn('[PMT] no flair control matched on this submit page');
    }
  }

  /* --- strategies, in order of confidence --- */

  // 1. the exact selector for this subreddit's flair
  function bySelector() {
    if (!settings.flairSelector) return false;
    var n;
    try {
      n = document.querySelector(settings.flairSelector);
    } catch (e) {
      console.warn('[PMT] bad flair selector: ' + settings.flairSelector);
      settings.flairSelector = '';
      return false;
    }
    if (!n || !visible(n)) return false;
    click(n);
    return true;
  }

  // 2. a flair label whose text is the flair name
  function byLabelText() {
    var nodes = document.querySelectorAll('.linkflairlabel, [class*="flairlabel"]');
    for (var i = 0; i < nodes.length; i++) {
      if (norm(nodes[i].textContent) === target && visible(nodes[i])) {
        click(nodes[i]);
        return true;
      }
    }
    return false;
  }

  // 3. a plain <select> of flairs
  function bySelect() {
    var selects = document.querySelectorAll('select');
    for (var i = 0; i < selects.length; i++) {
      for (var j = 0; j < selects[i].options.length; j++) {
        var opt = selects[i].options[j];
        if (norm(opt.textContent) !== target && norm(opt.value) !== target) continue;
        selects[i].value = opt.value;
        selects[i].dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // 4. anything flair-ish whose text is the flair name
  function byAnyText() {
    var scopes = document.querySelectorAll('[class*="flair"], [id*="flair"]');
    for (var i = 0; i < scopes.length; i++) {
      var nodes = scopes[i].querySelectorAll('a, li, span, label, div, button');
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (norm(n.textContent) !== target) continue;
        if (n.querySelector('a, li, span, label, div, button')) continue; // innermost only
        if (!visible(n)) continue;
        click(n);
        return true;
      }
    }
    return false;
  }

  function open() {
    var btn = document.querySelector(OPEN_SELECTOR);
    if (btn && visible(btn)) { btn.click(); return true; }
    var nodes = document.querySelectorAll('button, a, [class*="flair"]');
    for (var i = 0; i < nodes.length; i++) {
      var t = norm(nodes[i].textContent);
      if (t === 'flair' || t === 'add flair' || t === 'select flair' || t === 'choose a flair') {
        if (!visible(nodes[i])) continue;
        nodes[i].click();
        return true;
      }
    }
    return false;
  }

  // The dropdown needs its own apply/save click to commit the choice. Only the
  // configured selector is ever clicked, and never if it belongs to the post form.
  function apply() {
    if (!settings.flairApplySelector) return 'skipped';
    var btn;
    try {
      btn = document.querySelector(settings.flairApplySelector);
    } catch (e) {
      console.warn('[PMT] bad apply selector: ' + settings.flairApplySelector);
      return 'skipped';
    }
    if (!btn || !visible(btn)) return 'missing';
    var form = btn.closest('form');
    if (form && (form.id === 'newlink' ||
                 form.querySelector('input[name="title"], textarea[name="text"]'))) {
      console.warn('[PMT] refusing to click apply: it belongs to the post form');
      return 'refused';
    }
    btn.click();
    return 'clicked';
  }

  function selected(how) {
    setTimeout(function () {
      var r = apply();
      finish(true, how + (r === 'clicked' ? ' + apply' : ' (apply ' + r + ')'));
    }, 250);
  }

  function attempt() {
    if (done) return;
    if (!opened && open()) {
      opened = true;
      return setTimeout(attempt, 300); // let the picker render before looking in it
    }
    if (bySelector()) return selected('selector');
    if (byLabelText()) return selected('label text');
    if (bySelect()) return selected('select');
    if (byAnyText()) return selected('text match');
    if (Date.now() - started > TIMEOUT) return finish(false);
    setTimeout(attempt, 400);
  }

  function start() {
    chrome.storage.sync.get(
      { flairSelector: DEFAULT_SELECTOR, flairApplySelector: DEFAULT_APPLY },
      function (v) {
        if (v && typeof v.flairSelector === 'string') settings.flairSelector = v.flairSelector.trim();
        if (v && typeof v.flairApplySelector === 'string') settings.flairApplySelector = v.flairApplySelector.trim();
        started = Date.now();
        attempt();
      }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 400); });
  } else {
    setTimeout(start, 400);
  }
})();
