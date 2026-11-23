/*
 * liquipedia.js - reading Liquipedia pages.
 *
 * *Finding* the right page is background.js's job: that needs a real browser
 * tab, because a service-worker fetch gets a captcha it cannot solve. This file
 * is pure parsing - hand it a document, get back structured data.
 */

/* ------------------------------------------------------------------ shared */

function lpText(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}


function normalizeTeamName(name) {
  var normalized = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(the|team|esports?|gaming|cs|club|clan)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

  var aliases = {
    navi: 'natusvincere',
    innercircle: 'ic',
    nip: 'ninjasinpyjamas',
    '1w': '1win',
    lag: "life's a game",
  };

  return aliases[normalized] || normalized;
}

function isMatchingTeam(hltvName, liquipediaName) {
  var expected = normalizeTeamName(hltvName);
  var actual = normalizeTeamName(liquipediaName);

  return !!expected && expected === actual;
}


// Liquipedia flag images are named like ".../36px-Fr_hd.png"
function lpFlag(img) {
  if (!img) return '';
  var file = (img.getAttribute('src') || '').split('/').pop();
  var m = file.match(/(?:\d+px-)?([A-Za-z]{2,3})_hd\./);
  return m ? m[1].toUpperCase() : '';
}

function lpPageTitle(doc) {
  return lpText(doc.querySelector('#firstHeading')) ||
    lpText(doc.querySelector('.fo-nttax-infobox .infobox-header')).replace(/^\[e\]\[h\]/, '').trim();
}

// The infobox social links are tagged by an <i class="lp-icon lp-twitter"> etc.
// Rendered in this order, at most one per network, skipping absent ones.
var LINK_ORDER = [
  ['home', 'Official Site'], ['faceit', 'Faceit'], ['twitter', 'Twitter'],
  ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'],
  ['weibo', 'Weibo'], ['douyin', 'Douyin'], ['youtube', 'YouTube'],
  ['twitch', 'Twitch'], ['bilibili', 'Bilibili'], ['discord', 'Discord'],
  ['steam', 'Steam'], ['vk', 'VK'], ['reddit', 'Reddit'], ['snapchat', 'Snapchat'],
  ['telegram', 'Telegram'], ['linkedin', 'LinkedIn'], ['bluesky', 'Bluesky'],
  ['threads', 'Threads']
];

/*
 * Links reddit will not have.
 *
 * r/GlobalOffensive's spam filter autoremoves posts linking to Russian social
 * media, Telegram or Discord, and it takes down the whole thread over one of
 * them - a CIS team's infobox routinely carries three. They are dropped here,
 * at the one place a third-party URL can enter the body.
 *
 * Two rules, because neither signal covers the other's ground. The icon
 * Liquipedia tags a link with says which network it is, and that is what
 * catches a Discord invite behind a vanity redirect. The host catches what the
 * icon cannot: a blocked link is as often the Official Site as it is the VK
 * one. `.ru` as a rule already covers vk.ru, vkvideo.ru, ok.ru and rutube.ru
 * without naming them, so only the networks sitting on other TLDs are listed.
 *
 * The same filters remove a post that names a gambling brand, so a link that
 * carries one in its host or handle goes too (censor.js) - twitter.com/
 * BCGameEsports, betclicapogee.gg - while the team's unbranded links stay.
 */
var BLOCKED_LINK_KIND = { vk: 1, telegram: 1, discord: 1 };

var BLOCKED_LINK_HOST =
  /(^|\.)(vk\.(com|cc)|vkplay\.live|t\.me|telegram\.(me|org|dog)|discord(app)?\.(gg|com|me)|dsc\.gg)$|\.ru$/i;

function isBlockedLink(kind, url) {
  if (BLOCKED_LINK_KIND[kind]) return true;
  if (typeof isGamblingLink === 'function' && isGamblingLink(url)) return true;
  try {
    return BLOCKED_LINK_HOST.test(new URL(url, 'https://liquipedia.net').hostname);
  } catch (e) {
    return false;
  }
}

function infoboxLinks(doc) {
  var byKind = {};
  var box = doc.querySelector('.fo-nttax-infobox');
  Array.prototype.forEach.call(box ? box.querySelectorAll('a') : [], function (a) {
    var i = a.querySelector('i.lp-icon');
    if (!i) return;
    var m = (i.className || '').match(/lp-([a-z0-9]+)(?:\s|$)/g);
    if (!m) return;
    var kind = '';
    (i.className || '').split(/\s+/).forEach(function (c) {
      if (c.indexOf('lp-') === 0 && c !== 'lp-icon') kind = kind || c.slice(3);
    });
    var href = a.getAttribute('href') || '';
    if (!kind || !/^https?:/.test(href)) return;
    if (!byKind[kind]) byKind[kind] = href;      // keep the first of each
  });

  var out = [];
  var blocked = [];
  LINK_ORDER.forEach(function (pair) {
    var href = byKind[pair[0]];
    if (!href) return;
    delete byKind[pair[0]];
    if (isBlockedLink(pair[0], href)) blocked.push(pair[1]);
    else out.push({ label: pair[1], url: href });
  });
  // what was dropped, for the run log to name it; the links are the return
  // value and nothing else reads this
  out.blocked = blocked;
  return out;
}

/* ----------------------------------------------------- what page is this? */

/*
 * A search can hand back a page that is not the thing that was asked for, and
 * the parsers will not complain: a tournament page has an infobox with social
 * links in it and a name in its header, so `Bebop` resolving to European Pro
 * League Series 6 Play-In produced a thread listing that tournament as one of
 * the teams, wearing the tournament's Twitter and Twitch. It renders perfectly.
 * It is just wrong, which is the failure mode worth spending code on.
 *
 * Liquipedia labels the infobox with what the page is - every team page carries
 * a `Team Information` header, every tournament a `League Information` one,
 * players a `Player Information` one. That is the whole check: the wiki has
 * already answered the question, in one place, in words.
 *
 * The page categories are kept as a second opinion for the pages that have no
 * infobox at all. That matters only for events, whose streams and bracket are
 * read from the body rather than the infobox - a team page without an infobox
 * has no name and no links to give, so there is nothing to rescue.
 */
var KIND_BY_INFOBOX = [
  ['team', /^Team Information$/i],
  ['tournament', /^(League|Tournament) Information$/i],
  ['player', /^Player Information$/i],
  ['organisation', /^Organi[sz]ation Information$/i]
];

function infoboxHeaders(doc) {
  var box = doc.querySelector('.fo-nttax-infobox');
  if (!box) return [];
  return Array.prototype.map.call(box.querySelectorAll('.infobox-header'), function (h) {
    return lpText(h).replace(/^\[e\]\[h\]/, '').trim();
  });
}

function pageCategories(doc) {
  var box = doc.querySelector('#catlinks');
  if (!box) return [];
  return Array.prototype.map.call(box.querySelectorAll('a'), function (a) {
    return (a.textContent || '').replace(/\s+/g, ' ').trim();
  }).filter(function (t) { return t && !/^Categor(y|ies)$/i.test(t); });
}

// Tournament first: a tournament is also filed under `Team Tournaments`, and
// matching the end of the category is what keeps that from reading as a team.
var KIND_BY_CATEGORY = [
  ['tournament', /Tournaments$/],
  ['team', /Teams$/],
  ['player', /Players$/],
  ['organisation', /(Organizers|Organisations)$/]
];

function firstMatch(table, values) {
  for (var i = 0; i < table.length; i++) {
    for (var v = 0; v < values.length; v++) {
      if (table[i][1].test(values[v])) return table[i][0];
    }
  }
  return '';
}

function liquipediaPageKind(doc) {
  if (!doc) return 'unknown';
  return firstMatch(KIND_BY_INFOBOX, infoboxHeaders(doc)) ||
         firstMatch(KIND_BY_CATEGORY, pageCategories(doc)) ||
         'unknown';
}

// What the run log and the panel note should call it. Reads in both directions:
// a team slot can land on a tournament, and an event slot on a team.
function describeKind(kind) {
  if (kind === 'tournament') return 'a tournament page';
  if (kind === 'team') return 'a team page';
  if (kind === 'player') return 'a player page';
  if (kind === 'organisation') return 'an organisation page';
  return 'the wrong kind of page';
}

// A one-line summary of what a team page yielded, for the run log.
function teamSummary(t) {
  if (!t) return null;
  return {
    name: t.name, links: t.links.length,
    roster: t.roster.length, coaches: t.coaches.length, benched: t.benched.length,
    rosterNicks: t.roster.map(function (p) { return p.nick; })
  };
}

/* -------------------------------------------------------------- team pages */

// The active squad table lists players first and support staff after, with the
// role in an unlabelled column ("Coach"). A separate "Inactive" table holds
// benched players and has no such column - hence finding it by the blank
// header rather than by position, or a benched player's join date reads as a
// role and they get dropped.
function parseSquadTable(table) {
  if (!table) return [];
  var headers = Array.prototype.map.call(
    table.querySelectorAll('tr.table2__row--head th'), lpText
  );
  var roleIdx = -1;
  for (var i = 2; i < headers.length; i++) {
    if (!headers[i]) { roleIdx = i; break; }
  }
  return Array.prototype.map.call(table.querySelectorAll('tr.table2__row--body'), function (row) {
    var idCell = row.children[0];
    var link = idCell && idCell.querySelector('a');
    return {
      nick: lpText(link) || lpText(idCell),
      flag: lpFlag(idCell && idCell.querySelector('.flag img')),
      position: roleIdx >= 0 ? lpText(row.children[roleIdx]) : ''
    };
  }).filter(function (p) { return p.nick; });
}

// The role column holds support staff ("Coach", "Analyst") but also qualifiers
// that still describe a playing member ("Loan", "Stand-in", "Trial"). Only the
// staff titles disqualify someone from the roster - treating any label as staff
// silently dropped OG's two loaned-in players, who had in fact just played the
// match.
var STAFF_ROLE = /coach|analyst|manager|director|assistant|psycholog|owner|ceo|scout|staff/i;

function isPlayer(p) {
  return !STAFF_ROLE.test(p.position || '');
}

function headingFor(table) {
  var n = table;
  while (n) {
    var p = n.previousElementSibling;
    while (p) {
      var h = p.matches && p.matches('h2,h3,h4') ? p : (p.querySelector ? p.querySelector('h2,h3,h4') : null);
      if (h) return lpText(h);
      p = p.previousElementSibling;
    }
    n = n.parentElement;
  }
  return '';
}

function parseTeamPage(doc, url) {
  var tables = doc.querySelectorAll('.table2__table');
  var active = null, inactive = null;
  for (var i = 0; i < tables.length; i++) {
    var head = lpText(tables[i].querySelector('tr.table2__row--head'));
    if (!/^ID/.test(head)) continue;                  // skip results tables
    var heading = headingFor(tables[i]);
    if (!active && /^Active/i.test(heading)) active = tables[i];
    else if (!inactive && /^Inactive/i.test(heading)) inactive = tables[i];
    if (active && inactive) break;
  }

  var squad = parseSquadTable(active);
  var benched = parseSquadTable(inactive).filter(isPlayer);

  return {
    url: url,
    // the page's id, for a link that cannot carry the page's name (censor.js)
    articleId: typeof liquipediaArticleId === 'function' ? liquipediaArticleId(doc) : '',
    name: lpText(doc.querySelector('.fo-nttax-infobox .infobox-header'))
            .replace(/^\[e\]\[h\]/, '').trim() || lpText(doc.querySelector('#firstHeading')),
    links: infoboxLinks(doc),
    roster: squad.filter(isPlayer),
    coaches: squad.filter(function (p) { return /coach/i.test(p.position); }),
    benched: benched
  };
}

/* ------------------------------------------------------------- event pages */

// The stream tables ("Primary" / "Secondary") put one language per column. Only
// the first column is used, and at most one Twitch and one YouTube link from it.
function parseStreams(doc) {
  var youtube = '';
  var twitch = [];
  Array.prototype.forEach.call(doc.querySelectorAll('table.wikitable'), function (t) {
    var head = lpText(t.querySelector('th'));
    if (!/^(Primary|Secondary)$/i.test(head)) return;
    var row = Array.prototype.filter.call(t.querySelectorAll('tr'), function (r) {
      return /^Streams?$/i.test(lpText(r.querySelector('th')));
    })[0];
    if (!row) return;
    var cell = row.querySelector('td');
    if (!cell) return;
    var gotTwitch = false;
    Array.prototype.forEach.call(cell.querySelectorAll('a'), function (a) {
      var href = a.getAttribute('href') || '';
      // a channel named after a betting sponsor is a link the filters remove
      if (typeof isGamblingLink === 'function' && isGamblingLink(href)) return;
      if (!gotTwitch && /twitch\.tv\//.test(href)) { twitch.push(href); gotTwitch = true; }
      if (!youtube && /youtube\.com\//.test(href)) youtube = href;
    });
  });

  var out = [];
  if (youtube) out.push({ label: 'YouTube', url: youtube });
  twitch.forEach(function (url, i) {
    out.push({ label: 'Twitch ' + String.fromCharCode(65 + i), url: url });
  });
  return out;
}

/* ---------------------------------------------------------------- brackets */

function bracketNames(entry) {
  var dyn = entry.querySelector('.team-name-dynamic');
  var out = [];
  if (dyn) {
    ['teamName', 'teamBracketname', 'teamShortname'].forEach(function (k) {
      if (dyn.dataset[k]) out.push(dyn.dataset[k]);
    });
  }
  var aria = entry.getAttribute('aria-label');
  if (aria) out.push(aria);
  return out;
}

function matchEntries(match) {
  return Array.prototype.map.call(
    match.querySelectorAll(':scope > .brkts-opponent-entry'),
    function (e) {
      return {
        names: bracketNames(e),
        score: lpText(e.querySelector('.brkts-opponent-score-inner')),
        won: !!e.querySelector('.brkts-opponent-win')
      };
    }
  );
}

/*
 * Working out which round a match belongs to.
 *
 * A bracket is not one column list. A double-elimination group is rendered as
 * several sections, each with its own header row followed by its trees:
 *
 *   .brkts-bracket
 *     .brkts-round-header      Upper Bracket QF | Upper Bracket SF | Qualified
 *     .brkts-round-body        (an upper bracket tree)
 *     .brkts-round-body        (another)
 *     .brkts-round-header      Lower Bracket QF | Lower Bracket SF | Qualified
 *     .brkts-round-body        (lower bracket trees)
 *     ...
 *
 * Sections are not always side by side at the top, though. A bracket that
 * runs both halves into one grand final nests the lower half - header row and
 * all - inside the grand final's tree:
 *
 *   .brkts-bracket
 *     .brkts-round-header      Upper Bracket QF | Upper SF | Upper Final | Grand Final
 *     .brkts-round-body        (the grand final)
 *       .brkts-round-lower
 *         .brkts-round-body    (the upper final, and the upper half under it)
 *         .brkts-round-header  Lower Bracket Round 1 | Lower QF | Lower SF | Lower Final
 *         .brkts-round-body    (the lower final, and the lower half under it)
 *
 * Reading only the top-level header put every lower-bracket match under the
 * upper one: Fnatic, winning Lower Bracket Round 1 at Stake Ranked Episode 4,
 * "advanced to Upper Quarter Finals". So the header that governs a match is
 * the nearest one before any of its ancestors, and the tree that header heads
 * is what its column is counted within.
 *
 * Within a section the trees nest, so a match's column is found by counting
 * back from the section's last *playable* column - trailing "Qualified" columns
 * are qualification slots, not rounds, and counting them is what made an upper
 * bracket quarter-final report that its winner advanced to "Qualified".
 */

// { header, root }: the header row governing this match, and the subtree
// (the ancestor right after that header) whose columns it names.
function sectionOf(match, bracket) {
  for (var n = match; n && n !== bracket; n = n.parentElement) {
    var p = n.previousElementSibling;
    while (p && !p.classList.contains('brkts-round-header')) p = p.previousElementSibling;
    if (p) return { header: p, root: n };
  }
  return { header: null, root: bracket };
}

// How many round-bodies deep the match sits inside its section's tree.
function matchDepth(match, root) {
  var d = 0;
  for (var n = match.parentElement; n; n = n.parentElement) {
    if (n.classList && n.classList.contains('brkts-round-body')) d++;
    if (n === root) break;
  }
  return d;
}

function sectionHeader(match, bracket) {
  return sectionOf(match, bracket).header;
}

// Each header cell repeats itself at several lengths; the first option is the
// long form ("Upper Bracket Semifinals"), which is the one worth printing.
function headerNames(header) {
  if (!header) return [];
  return Array.prototype.map.call(header.querySelectorAll(':scope > .brkts-header'), function (h) {
    var opt = h.querySelector('.brkts-header-option');
    return ((opt ? opt.textContent : h.textContent) || '').replace(/\s+/g, ' ').trim();
  });
}

function roundNameFor(match, bracket) {
  var section = sectionOf(match, bracket);
  var names = headerNames(section.header);
  if (!names.length) return '';
  var last = names.length - 1;
  while (last > 0 && /^qualif/i.test(names[last])) last--;   // drop the qualification slots
  var col = last - (matchDepth(match, section.root) - 1);
  return names[col] || '';
}

function firstCenterMatch(node) {
  if (!node) return null;
  var center = Array.prototype.filter.call(node.children, function (c) {
    return c.classList.contains('brkts-round-center');
  })[0];
  return center ? center.querySelector(':scope > .brkts-match') : null;
}

function parentMatch(match) {
  var center = match.closest('.brkts-round-center');
  var body = center && center.parentElement;
  var lower = body && body.parentElement;
  if (!lower || !lower.classList.contains('brkts-round-lower')) return null;
  return firstCenterMatch(lower.parentElement);
}

// Immediate feeder matches: the round-bodies sitting under this match's own
// .brkts-round-lower. That is how a TBA slot in the parent is turned back into
// the two teams still playing for it.
function childMatches(match) {
  var center = match.closest('.brkts-round-center');
  var body = center && center.parentElement;
  if (!body) return [];
  var out = [];
  Array.prototype.forEach.call(body.children, function (c) {
    if (!c.classList.contains('brkts-round-lower')) return;
    Array.prototype.forEach.call(c.children, function (kid) {
      if (!kid.classList.contains('brkts-round-body')) return;
      var m = firstCenterMatch(kid);
      if (m) out.push(m);
    });
  });
  return out;
}

function sectionKind(match, bracket) {
  var names = headerNames(sectionHeader(match, bracket));
  for (var i = 0; i < names.length; i++) {
    if (/lower/i.test(names[i])) return 'lower';
    if (/upper/i.test(names[i])) return 'upper';
  }
  return '';
}

// "Semifinals" -> "Semi Finals", "Upper Bracket Final" -> "Upper Final".
// "Grand Final" and "Round of 16" are left alone.
function prettyRound(name) {
  return String(name || '')
    .replace(/\s+Bracket\s+/i, ' ')
    .replace(/(quarter|semi)\s*-?\s*finals?/gi, function (all, word) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + ' Finals';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

var ORG_WORDS = ['esports', 'esport', 'gaming', 'team', 'club'];

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// HLTV says "Falcons" where the bracket says "Team Falcons", so a comparison on
// the significant words has to succeed too - otherwise a match is only found
// when the Liquipedia team page happened to load and supply its own spelling.
function orgName(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (w) { return w && ORG_WORDS.indexOf(w) < 0; })
    .join('');
}

function nameMatches(entryNames, candidates) {
  for (var i = 0; i < entryNames.length; i++) {
    for (var j = 0; j < candidates.length; j++) {
      if (!candidates[j]) continue;
      if (normName(entryNames[i]) === normName(candidates[j])) return true;
      if (orgName(entryNames[i]) && orgName(entryNames[i]) === orgName(candidates[j])) return true;
    }
  }
  return false;
}

// HLTV is the source of truth for who won: Liquipedia's cell often lags a map
// behind (this page still said 1-1 after HLTV had 2-1). The win marker and the
// cell scores are only a fallback when HLTV did not supply a decisive score.
function winningEntry(entries, wantScores) {
  var a = Number(wantScores[0]), b = Number(wantScores[1]);
  if (isFinite(a) && isFinite(b) && a !== b) return a > b ? entries[0] : entries[1];
  var marked = entries.filter(function (e) { return e.won; })[0];
  if (marked) return marked;
  var hi = Math.max(a, b);
  if (!isFinite(hi) || hi <= 0) return null;
  return entries.filter(function (e) { return Number(e.score) === hi; })[0] || null;
}

function scoresEqual(entries, want) {
  return String(entries[0].score) === String(want[0]) &&
    String(entries[1].score) === String(want[1]);
}

// Match popups contain the HLTV link and a countdown timestamp. These identify
// a series more reliably than its score: the same teams can win 2-0 twice.
function bracketMatchInfo(match) {
  var ids = [];
  Array.prototype.forEach.call(match.querySelectorAll('a[href]'), function (a) {
    try {
      var u = new URL(a.getAttribute('href'), 'https://liquipedia.net');
      var m = /^(?:www\.)?hltv\.org$/i.test(u.hostname) && u.pathname.match(/^\/matches\/(\d+)(?:\/|$)/);
      if (m && ids.indexOf(m[1]) < 0) ids.push(m[1]);
    } catch (e) { /* not an external match link */ }
  });
  var timer = match.querySelector('.match-info-countdown [data-timestamp], .timer-object[data-timestamp]');
  var time = Number(timer && timer.getAttribute('data-timestamp')) || 0;
  if (!isFinite(time) || time < 0) time = 0;
  if (time > 0 && time < 1e12) time *= 1000; // Liquipedia seconds -> HLTV milliseconds
  return { ids: ids, time: time };
}

function stageInfo(label) {
  var text = String(label || '').toLowerCase();
  var compact = text.replace(/[^a-z0-9]/g, '');
  var group = text.match(/\bgroup\s+([a-z]|\d+)\b/);
  var round = /(?:third|3rd)place/.test(compact) ? 'third place' :
    /quarterfinal/.test(compact) ? 'quarter final' :
    /semifinal/.test(compact) ? 'semi final' :
    /final/.test(compact) ? 'final' : '';
  var numbered = compact.match(/roundof(\d+)|round(\d+)/);
  if (!round && numbered) round = numbered[1] ? 'round of ' + numbered[1] : 'round ' + numbered[2];
  return {
    round: round,
    side: /\bupper\b|\bub\b/.test(text) ? 'upper' : /\blower\b|\blb\b/.test(text) ? 'lower' : '',
    phase: /\bplay\s*-?\s*offs?\b/.test(text) ? 'playoffs' : /\bgroup\b|\bswiss\b/.test(text) ? 'groups' : '',
    group: group ? group[1] : ''
  };
}

// Keep the nearest heading at each level. For Group B, this includes Group
// Stage, but never the previous Group A heading. MediaWiki also wraps headings.
function bracketStage(bracket) {
  var labels = [];
  var level = 7;
  for (var n = bracket; n && level > 2; n = n.parentElement) {
    for (var p = n.previousElementSibling; p && level > 2; p = p.previousElementSibling) {
      var h = p.matches('h1,h2,h3,h4,h5,h6') ? p :
        p.classList.contains('mw-heading') ? p.querySelector('h1,h2,h3,h4,h5,h6') : null;
      var nextLevel = h ? Number(h.tagName.slice(1)) : 0;
      if (!nextLevel || nextLevel >= level) continue;
      labels.push(lpText(h));
      level = nextLevel;
    }
  }
  return stageInfo(labels.join(' '));
}

function stageMatches(candidate, want) {
  var actual = stageInfo(roundNameFor(candidate.match, candidate.bracket));
  var phase = bracketStage(candidate.bracket);
  if (want.phase && phase.phase && want.phase !== phase.phase) return false;
  if (want.group && phase.group && want.group !== phase.group) return false;
  if (want.round && actual.round && want.round !== actual.round) return false;
  if (want.side && actual.side && want.side !== actual.side) return false;
  // HLTV's unqualified playoff Semi-final is not a group Upper Semi-final.
  if (want.round && actual.round && !want.side && actual.side && want.phase !== 'groups') return false;
  return true;
}

// A repeated pairing must be disambiguated by the match link, date or stage.
// A matching score (or the only slot without a winner) cannot identify it:
// an earlier group result may match while the playoff result is still pending.
function pickNamedMatch(found, context) {
  context = context || {};
  var matchId = String(context.matchId || '');
  var identified = matchId ? found.filter(function (x) { return x.info.ids.indexOf(matchId) >= 0; }) : [];
  if (identified.length) {
    if (identified.length !== 1) return null;
    identified[0].matchedBy = 'match ID';
    return identified[0];
  }
  var wantStage = stageInfo(context.stage);
  var time = Number(context.matchTime) || 0;
  var pool = found.filter(function (x) {
    if (matchId && x.info.ids.length && x.info.ids.indexOf(matchId) < 0) return false;
    // Date-only entries use midnight; delayed starts may cross midnight.
    if (time && x.info.time && Math.floor(time / 86400000) !== Math.floor(x.info.time / 86400000) &&
        Math.abs(time - x.info.time) > 12 * 3600000) return false;
    return stageMatches(x, wantStage);
  });
  if (time) {
    var dated = pool.filter(function (x) { return x.info.time; });
    if (dated.length) pool = dated;
  }
  if (pool.length !== 1) return null;
  pool[0].matchedBy = time && pool[0].info.time ? 'match date' : context.stage ? 'stage and pairing' : 'unique pairing';
  return pool[0];
}

function opponentNames(entries) {
  var out = [];
  (entries || []).forEach(function (e) {
    var n = e.names && e.names[0];
    if (!n) return;
    if (out.some(function (x) { return nameMatches([x], e.names); })) return;
    out.push(n);
  });
  return out.sort(function (a, b) { return a.localeCompare(b); });
}

// Who a team will face in `match`. A named slot is used as-is; a TBA slot is
// expanded to the teams still playing in the feeder that is not `exceptMatch`.
function facingTeams(match, exceptNames, exceptMatch) {
  var named = matchEntries(match).filter(function (e) {
    return e.names.length && !nameMatches(e.names, exceptNames);
  });
  if (named.length) return named;
  var out = [];
  childMatches(match).forEach(function (k) {
    if (k === exceptMatch) return;
    var kids = matchEntries(k).filter(function (e) { return e.names.length; });
    if (kids.some(function (e) { return nameMatches(e.names, exceptNames); })) return;
    if (kids.length) {
      kids.forEach(function (e) { out.push(e); });
      return;
    }
    facingTeams(k, exceptNames, exceptMatch).forEach(function (e) { out.push(e); });
  });
  return out;
}

function upcomingFor(bracket, teamNames, except) {
  var matches = bracket.querySelectorAll('.brkts-match');
  for (var i = 0; i < matches.length; i++) {
    if (matches[i] === except) continue;
    var entries = matchEntries(matches[i]);
    if (!entries.some(function (e) { return nameMatches(e.names, teamNames); })) continue;
    if (entries.some(function (e) { return e.won; })) continue;
    return matches[i];
  }
  return null;
}

/*
 * Finds this match in the event's brackets and reports what happens next.
 * `teamNames` is [[names for team1], [names for team2]] - HLTV's name and the
 * Liquipedia one, since the bracket may use either.
 *
 * Returns { advance, drop } or null. `advance` is the winner's next round, and
 * `drop` is the loser's landing in the opposite section (upper → lower). Either
 * side may list two opponents when that slot is still being played for - that
 * used to be treated as "not decided" and the whole line was dropped.
 */
function nextRound(doc, teamNames, scores, context) {
  var found = [];
  var brackets = doc.querySelectorAll('.brkts-bracket');
  for (var b = 0; b < brackets.length; b++) {
    var bracket = brackets[b];
    var matches = bracket.querySelectorAll('.brkts-match');
    for (var m = 0; m < matches.length; m++) {
      var entries = matchEntries(matches[m]);
      if (entries.length !== 2) continue;
      var a = nameMatches(entries[0].names, teamNames[0]) && nameMatches(entries[1].names, teamNames[1]);
      var flipped = nameMatches(entries[0].names, teamNames[1]) && nameMatches(entries[1].names, teamNames[0]);
      if (!a && !flipped) continue;
      var want = flipped ? [scores[1], scores[0]] : scores;
      found.push({
        match: matches[m],
        bracket: bracket,
        entries: entries,
        flipped: flipped,
        want: want,
        info: bracketMatchInfo(matches[m]),
        exact: scoresEqual(entries, want)
      });
    }
  }

  var pick = pickNamedMatch(found, context);
  if (!pick) return null;

  var entries = pick.entries;
  var want = pick.want;
  var flipped = pick.flipped;
  var winner = winningEntry(entries, want);
  var loser = winner
    ? entries.filter(function (e) { return e !== winner; })[0]
    : null;
  var result = {};

  var parent = parentMatch(pick.match);
  if (parent && winner) {
    var round = prettyRound(roundNameFor(parent, pick.bracket));
    if (round && !/^qualif/i.test(round)) {
      result.advance = {
        round: round,
        opponents: opponentNames(facingTeams(parent, winner.names, pick.match))
      };
    }
  }

  if (loser && sectionKind(pick.match, pick.bracket) === 'upper') {
    var dropMatch = upcomingFor(pick.bracket, loser.names.concat(flipped ? teamNames[0] : teamNames[1]),
                                pick.match);
    if (dropMatch && sectionKind(dropMatch, pick.bracket) === 'lower') {
      result.drop = {
        dest: 'the Lower bracket',
        opponents: opponentNames(facingTeams(dropMatch, loser.names, pick.match))
      };
    }
  }

  if (!(result.advance || result.drop)) return null;
  result.lpScores = [entries[0].score, entries[1].score];
  result.scoreMatched = pick.exact;
  result.matchedBy = pick.matchedBy;
  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseTeamPage: parseTeamPage, parseStreams: parseStreams, teamSummary: teamSummary,
    nextRound: nextRound, prettyRound: prettyRound, infoboxLinks: infoboxLinks, lpFlag: lpFlag,
    liquipediaPageKind: liquipediaPageKind, pageCategories: pageCategories,
    infoboxHeaders: infoboxHeaders,
    describeKind: describeKind, lpPageTitle: lpPageTitle, isBlockedLink: isBlockedLink
  };
}
