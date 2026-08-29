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
 */
var BLOCKED_LINK_KIND = { vk: 1, telegram: 1, discord: 1 };

var BLOCKED_LINK_HOST =
  /(^|\.)(vk\.(com|cc)|vkplay\.live|t\.me|telegram\.(me|org|dog)|discord(app)?\.(gg|com|me)|dsc\.gg)$|\.ru$/i;

function isBlockedLink(kind, url) {
  if (BLOCKED_LINK_KIND[kind]) return true;
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
 * Within a section the trees nest, so a match's column is found by counting
 * back from the section's last *playable* column - trailing "Qualified" columns
 * are qualification slots, not rounds, and counting them is what made an upper
 * bracket quarter-final report that its winner advanced to "Qualified".
 */

function matchDepth(match, bracket) {
  var n = match.parentElement, d = 0;
  while (n && n !== bracket) {
    if (n.classList && n.classList.contains('brkts-round-body')) d++;
    n = n.parentElement;
  }
  return d;
}

// The header row governing this match: the nearest one before the top-level
// round-body the match sits in.
function sectionHeader(match, bracket) {
  var top = match;
  while (top && top.parentElement !== bracket) top = top.parentElement;
  if (!top) return null;
  var n = top.previousElementSibling;
  while (n && !n.classList.contains('brkts-round-header')) n = n.previousElementSibling;
  return n;
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
  var names = headerNames(sectionHeader(match, bracket));
  if (!names.length) return '';
  var last = names.length - 1;
  while (last > 0 && /^qualif/i.test(names[last])) last--;   // drop the qualification slots
  var col = last - (matchDepth(match, bracket) - 1);
  return names[col] || '';
}

function parentMatch(match) {
  var center = match.closest('.brkts-round-center');
  var body = center && center.parentElement;
  var lower = body && body.parentElement;
  if (!lower || !lower.classList.contains('brkts-round-lower')) return null;
  var parentBody = lower.parentElement;
  if (!parentBody) return null;
  var parentCenter = Array.prototype.filter.call(parentBody.children, function (c) {
    return c.classList.contains('brkts-round-center');
  })[0];
  return parentCenter ? parentCenter.querySelector(':scope > .brkts-match') : null;
}

// "Semifinals" -> "Semi Finals", "Upper Bracket Semifinals" -> "Upper Bracket
// Semi Finals". "Grand Final" and "Round of 16" are left alone.
function prettyRound(name) {
  return String(name || '').replace(/(quarter|semi)\s*-?\s*finals?/gi, function (all, word) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + ' Finals';
  });
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

/*
 * Finds this match in the event's brackets and reports what the winner plays
 * next. `teamNames` is [[names for team1], [names for team2]] - HLTV's name and
 * the Liquipedia one, since the bracket may use either.
 *
 * Returns {round, opponent} or null when the match is not in a bracket (group
 * stages), is the final, or the next opponent is not decided yet.
 */
function nextRound(doc, teamNames, scores) {
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
      if (String(entries[0].score) !== String(want[0]) || String(entries[1].score) !== String(want[1])) continue;

      var parent = parentMatch(matches[m]);
      if (!parent) return null;
      var round = roundNameFor(parent, bracket);
      var winner = entries.filter(function (e) { return e.won; })[0];
      var opponent = matchEntries(parent).filter(function (e) {
        return !winner || !nameMatches(e.names, winner.names);
      })[0];
      if (!opponent || !opponent.names.length) return null;
      return { round: prettyRound(round), opponent: opponent.names[0] };
    }
  }
  return null;
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
