/*
 * hltv.js - everything read off HLTV: the match page, plus the round history on
 * a map stats page (needed only for overtime, which the match page reports as a
 * single aggregate).
 *
 * Pure with respect to the network - content.js does the fetching and passes
 * the documents in. render.js turns the result into markdown.
 */

/* ------------------------------------------------------------------ utils */

function txt(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

// "https://www.hltv.org/img/static/flags/30x20/DK.gif" -> "DK"
function flagCodeFromImg(img) {
  if (!img) return '';
  var src = img.getAttribute('src') || '';
  var m = src.match(/\/flags\/[^/]*\/([A-Za-z_-]+)\.(?:gif|png|svg)/);
  return m ? m[1].toUpperCase() : '';
}

// HLTV serves region pseudo-flags (EU/NAM/SAM/ASIA/WORLD) alongside real ISO
// country codes for multi-national rosters.
var REGION_EMOJI = {
  EU: '🇪🇺', NAM: '🌎', SAM: '🌎', ASIA: '🌏', WORLD: '🌍'
};

function flagEmoji(code) {
  var c = String(code || '').toUpperCase();
  if (REGION_EMOJI[c]) return REGION_EMOJI[c];
  if (!/^[A-Z]{2}$/.test(c)) return '🌍';
  return String.fromCodePoint(
    0x1f1e6 + c.charCodeAt(0) - 65,
    0x1f1e6 + c.charCodeAt(1) - 65
  );
}

// The subreddit only ships an EU icon and a generic globe for HLTV's regions.
var REGION_ANCHORS = { EU: 'eu', NAM: 'earth', SAM: 'earth', ASIA: 'earth', WORLD: 'earth' };

function langAnchor(code) {
  var c = String(code || '').toUpperCase();
  return '#lang-' + (REGION_ANCHORS[c] || c.toLowerCase());
}

// Org words Liquipedia hangs on a name that the flair table does not:
// "Team Falcons" and "FUT Esports" are stored as `falcons` and `fut`.
var FLAIR_ORG_WORDS = ['esports', 'esport', 'gaming', 'team', 'club'];

function flairNameCandidates(name) {
  var raw = String(name || '').trim();
  var out = [];
  var add = function (s) {
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  add(raw);
  var words = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  add(words.join(' '));
  add(words.filter(function (w) { return FLAIR_ORG_WORDS.indexOf(w) < 0; }).join(' '));
  return out;
}

function teamFlairSlugFor(name, overrides) {
  var cands = flairNameCandidates(name);
  for (var i = 0; i < cands.length; i++) {
    var slug = teamFlairSlug(cands[i], overrides);
    if (slug) return slug;
  }
  return null;
}

// The anchor a team's flag emoji links to: its logo flair when the subreddit
// has one, otherwise the team's country/region anchor. `name` may be one
// spelling or several (HLTV + Liquipedia + shortname) - the first that hits
// the flair table wins.
function teamAnchor(name, flagCode, overrides) {
  var names = Array.isArray(name) ? name : [name];
  var slug = null;
  for (var i = 0; i < names.length && !slug; i++) {
    slug = teamFlairSlugFor(names[i], overrides);
  }
  return slug ? '#' + slug + '-logo' : langAnchor(flagCode);
}

// `[🇧🇷](#legacy-logo) ` or `[🇪🇺](#lang-eu) ` or '' when we have neither a
// flair nor a flag. Empty flag + a flair still prints (globe + logo) so a
// team the event directory missed is not left as a bare name.
function teamTag(name, flagCode, overrides) {
  var names = (Array.isArray(name) ? name : [name]).filter(Boolean);
  var slug = null;
  for (var i = 0; i < names.length && !slug; i++) {
    slug = teamFlairSlugFor(names[i], overrides);
  }
  var flag = flagCode || '';
  if (!slug && !flag) return '';
  return '[' + flagEmoji(flag) + '](' +
    (slug ? '#' + slug + '-logo' : langAnchor(flag)) + ')';
}

function flagLink(code) {
  return '[' + flagEmoji(code) + '](' + langAnchor(code) + ')';
}

function titleCase(s) {
  return String(s || '').replace(/[A-Za-z][A-Za-z']*/g, function (w) {
    // leave acronyms and single letters ("EU", "B") alone
    if (w.length > 1 && w === w.toUpperCase()) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

function trimZeros(n) {
  return String(parseFloat(n.toFixed(2)));
}

// "$1,250,000" -> "$1.25m"; "$250,000" -> "$250k"; text without a number
// (e.g. "Spots in Closed Qualifier") -> ''
function shortPrize(raw) {
  var digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  var n = parseInt(digits, 10);
  if (!n) return '';
  if (n >= 1e6) return '$' + trimZeros(n / 1e6) + 'm';
  if (n >= 1e3) return '$' + trimZeros(n / 1e3) + 'k';
  return '$' + n;
}

// https://www.hltv.org/team/8474/100-thieves -> https://www.hltv.org//team/8474/100-thieves
// (the doubled slash is what the sample threads use; kept for fidelity)
function hltvDoubleSlash(href) {
  try {
    var u = new URL(href, 'https://www.hltv.org');
    return 'https://www.hltv.org/' + u.pathname.replace(/^\/*/, '/');
  } catch (e) {
    return href;
  }
}

// player.twitch.tv/?video=v2855211389&t=2h1m44s -> twitch.tv/videos/2855211389?t=2h1m44s
function normalizeVod(embed) {
  if (!embed) return '';
  var u;
  try {
    u = new URL(embed, 'https://www.hltv.org');
  } catch (e) {
    return embed;
  }
  if (/player\.twitch\.tv$/.test(u.hostname)) {
    var video = (u.searchParams.get('video') || '').replace(/^v/, '');
    var t = u.searchParams.get('t');
    if (video) return 'https://www.twitch.tv/videos/' + video + (t ? '?t=' + t : '');
  }
  if (/youtube\.com$/.test(u.hostname) && u.pathname.indexOf('/embed/') === 0) {
    var id = u.pathname.split('/')[2];
    var start = u.searchParams.get('start');
    return 'https://www.youtube.com/watch?v=' + id + (start ? '&t=' + start : '');
  }
  u.searchParams.delete('parent');
  u.searchParams.delete('autoplay');
  return u.toString();
}

/* ---------------------------------------------------------------- scraping */

function scrapeTeams(doc) {
  var box = doc.querySelector('.teamsBox');
  var teams = [];
  [1, 2].forEach(function (n) {
    var grad = box && box.querySelector('.team' + n + '-gradient');
    var link = grad && grad.querySelector('a[href*="/team/"]');
    var scoreEl = grad && grad.querySelector('.won, .lost, .tie');
    var countryImg = box && box.querySelector('img.team' + n);
    var href = link ? link.getAttribute('href') : '';
    teams.push({
      name: txt(grad && grad.querySelector('.teamName')),
      id: (href.match(/\/team\/(\d+)\//) || [])[1] || '',
      url: hltvDoubleSlash(href),
      urlPlain: href ? new URL(href, 'https://www.hltv.org').toString() : '',
      flag: flagCodeFromImg(countryImg),
      score: parseInt(txt(scoreEl), 10) || 0,
      won: !!(scoreEl && scoreEl.classList.contains('won'))
    });
  });
  return teams;
}

// The first veto-box holds "Best of 3 (Online)" plus "* <stage>. Winner advances ..."
function scrapeFormatBox(doc) {
  var el = doc.querySelector('.veto-box .padding.preformatted-text');
  var raw = el ? el.textContent : '';
  var lines = raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var bo = lines[0] || '';
  var notes = lines.filter(function (l) { return l.charAt(0) === '*'; })
                   .map(function (l) { return l.replace(/^\*\s*/, ''); });
  var sentences = (notes[0] || '').split(/(?:\.)\s+/)
                   .map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    bestOf: bo,
    venue: /\(LAN\)/i.test(bo) ? 'LAN' : 'Online',
    // "Quarter-final. Winner advances to the Closed Qualifier." -> "Quarter-Final"
    stage: titleCase((sentences[0] || '').replace(/\.$/, '')),
    outcomeSentences: sentences.slice(1).map(function (s) {
      return /\.$/.test(s) ? s : s + '.';
    })
  };
}

function scrapeVeto(doc, teams) {
  var boxes = doc.querySelectorAll('.veto-box .padding');
  var listBox = boxes[boxes.length - 1];
  if (!listBox || listBox.classList.contains('preformatted-text')) return [];
  var rows = [];
  Array.prototype.forEach.call(listBox.querySelectorAll('div'), function (div) {
    var line = txt(div).replace(/^\d+\.\s*/, '');
    var m = line.match(/^(.*?)\s+(removed|picked)\s+(.+)$/i);
    if (m) {
      var side = -1;
      teams.forEach(function (t, i) {
        if (t.name.toLowerCase() === m[1].trim().toLowerCase()) side = i;
      });
      rows.push({ side: side < 0 ? null : side, action: m[2].toLowerCase(), map: m[3].trim() });
      return;
    }
    m = line.match(/^(.+?)\s+was left over$/i);
    if (m) rows.push({ side: null, action: 'leftover', map: m[1].trim() });
  });
  return rows;
}

function scrapeMaps(doc) {
  var maps = [];
  Array.prototype.forEach.call(doc.querySelectorAll('.mapholder'), function (holder) {
    var name = txt(holder.querySelector('.mapname'));
    if (!name) return;
    var played = !!holder.querySelector('.results.played');
    var statsA = holder.querySelector('.results-center-stats a');
    var statsUrl = statsA
      ? new URL(statsA.getAttribute('href'), 'https://www.hltv.org').toString()
      : '';
    var mapstatsId = (statsUrl.match(/\/mapstatsid\/(\d+)\//) || [])[1] || '';
    var left = holder.querySelector('.results-left .results-team-score');
    var right = holder.querySelector('.results-right .results-team-score');

    // Half scores come as parenthesised groups: "(5:7; 7:5)" for regulation,
    // where each number carries a ct/t class, then one more "(1:4)" group per
    // overtime, whose spans are unclassed.
    var groups = [];
    var cur = null;
    Array.prototype.forEach.call(
      holder.querySelectorAll('.results-center-half-score span'),
      function (s) {
        var t = s.textContent;
        if (t.indexOf('(') >= 0) { cur = []; groups.push(cur); return; }
        if (t.indexOf(')') >= 0) { cur = null; return; }
        var n = parseInt(t, 10);
        if (isNaN(n) || !cur) return;
        cur.push({
          side: s.classList.contains('ct') ? 'CT' : s.classList.contains('t') ? 'T' : '',
          rounds: n
        });
      }
    );
    // groups[0] is [t1 first half, t2 first half, t1 second half, t2 second half]
    var ot = [0, 0];
    groups.slice(1).forEach(function (g) {
      ot[0] += g[0] ? g[0].rounds : 0;
      ot[1] += g[1] ? g[1].rounds : 0;
    });
    // HLTV puts `.results.played` on a revealed map even before it starts
    // (scores are "-"); won/lost is what means the map is actually over.
    // `.results.optional` is a leftover that has not been reached yet.
    var decided = !!(holder.querySelector(
      '.results-left.won, .results-left.lost, .results-right.won, .results-right.lost'
    ));
    var status = 'tba';
    if (!/^tba$/i.test(name) && holder.querySelector('.results')) {
      status = decided ? 'finished' : 'upcoming';
    }

    maps.push({
      name: name,
      played: played,
      status: status,
      optional: !!(holder.querySelector('.results.optional')),
      statsUrl: statsUrl,
      mapstatsId: mapstatsId,
      score: [parseInt(txt(left), 10) || 0, parseInt(txt(right), 10) || 0],
      halves: groups[0] || [],
      ot: ot,
      hasOt: groups.length > 1
    });
  });
  return maps;
}

// Whether the match is on now, and when it was due to start. The countdown
// node sits in `.timeAndEvent`: class `countdown-live` (or the text LIVE)
// once it is underway, otherwise a remaining "10m : 46s". `data-unix` is the
// scheduled start in milliseconds.
function scrapeLive(doc) {
  var el = doc.querySelector('.timeAndEvent .countdown');
  var text = txt(el);
  var unix = parseInt((el && el.getAttribute('data-unix')) || '0', 10) || 0;
  var isLive = !!(el && (el.classList.contains('countdown-live') || /^LIVE$/i.test(text)));
  return { isLive: isLive, countdown: text, unix: unix };
}

// Mark the current map LIVE. HLTV does not label it: the first revealed map
// that is not finished (and not the optional leftover) is the one being
// played, but only while the countdown says the match is on.
function markLiveMap(maps, live) {
  if (!live || !live.isLive) return maps;
  for (var i = 0; i < maps.length; i++) {
    if (maps[i].status === 'upcoming' && !maps[i].optional) {
      maps[i].status = 'live';
      break;
    }
  }
  return maps;
}

// Series score from finished maps. The teamsBox won/lost figure is missing
// (or still 0-0) on a live page, even after map 1 has been decided.
function seriesFromMaps(maps) {
  var a = 0, b = 0;
  (maps || []).forEach(function (m) {
    if (m.status !== 'finished') return;
    if (m.score[0] > m.score[1]) a++;
    else if (m.score[1] > m.score[0]) b++;
  });
  return [a, b];
}

// 0-based map index -> VOD url, taken from the "Rewatch" stream list labels.
function scrapeVods(doc) {
  var out = {};
  Array.prototype.forEach.call(doc.querySelectorAll('.streams [data-stream-embed]'), function (box) {
    var m = txt(box).match(/\(Map\s*(\d+)\s*-/i);
    if (!m) return;
    var idx = parseInt(m[1], 10) - 1;
    if (out[idx]) return; // the page lists every VOD twice (spoiler / no-spoiler)
    out[idx] = normalizeVod(box.getAttribute('data-stream-embed'));
  });
  return out;
}

// Live streams listed on the match page, in viewer order. The HLTV Live box
// is the site's own player and is skipped; the rest already carry a watch
// URL on `.external-stream a`. Used when Liquipedia has no stream table.
function scrapeHltvStreams(doc) {
  var out = [];
  var seen = {};
  Array.prototype.forEach.call(
    doc.querySelectorAll('.streams .stream-box[data-stream-provider]'),
    function (box) {
      var a = box.querySelector('.external-stream a[href], a[href]');
      var href = a ? a.getAttribute('href') : '';
      if (!href || seen[href]) return;
      var label = txt(box.querySelector('.stream-box-embed'));
      if (!label) return;
      seen[href] = true;
      out.push({
        label: label,
        url: href,
        flag: flagCodeFromImg(box.querySelector('.stream-flag')),
        provider: box.getAttribute('data-stream-provider') || ''
      });
    }
  );
  return out;
}

// HLTV publishes its own clip highlights on match pages that have them.
//
// Parenthesised asides are dropped and the surrounding whitespace kept as-is -
// "4 AK kills (3 HS) on the bombsite A offensive (1vs2 post-plant)" becomes
// "4 AK kills  on the bombsite A offensive ". Nothing else is trimmed.
//
// "(Part 1 - observer)" and friends are the exception: HLTV splits one play
// across several clips and only the part marker tells them apart, so dropping
// it would leave two identical links side by side.
function highlightTitle(text) {
  return String(text).replace(/\([^)]*\)/g, function (aside) {
    return /^\(\s*part\s/i.test(aside) ? aside : '';
  });
}

function scrapeHighlights(doc) {
  var out = [];
  Array.prototype.forEach.call(doc.querySelectorAll('.highlights .highlight[data-highlight-embed]'), function (h) {
    var embed = h.getAttribute('data-highlight-embed') || '';
    var slug = (embed.match(/[?&]clip=([^&]+)/) || [])[1];
    out.push({
      title: highlightTitle(h.textContent),
      url: slug ? 'https://clips.twitch.tv/' + slug : embed
    });
  });
  return out;
}

// The sidebar carries the event's prize pool ("$2,000,000", or "Other" when it
// is not a cash prize), so no event-page request is needed for it.
function scrapePrize(doc) {
  var found = '';
  Array.prototype.forEach.call(doc.querySelectorAll('.matchSidebarDataContainer'), function (c) {
    var label = txt(c.querySelector('.matchSidebarInfo'));
    if (/prizepool/i.test(label)) found = txt(c.querySelector('.matchSidebarData'));
  });
  return found;
}

// Nicks arrive in three spellings for the same player: HLTV's URL slug strips
// punctuation (`hunter`), HLTV's stats tables keep it (`huNter-`), and
// Liquipedia has its own (`huNter-`). Folding them all to letters and digits is
// what lets the three line up.
function nickKey(nick) {
  return String(nick || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Player roles, from HLTV's IGL/AWP pills. Indexed by player id as well as
// nick: the id is exact wherever we have one, and Liquipedia's roster - which
// has no HLTV ids - falls back to the nick. A player can hold more than one
// role (cadiaN captains and AWPs), so every pill is collected rather than
// the first.
//
// Match pages put the pills on `#lineups .player-compare` (or, on older
// markup, on a `/player/` link). HLTV strips that whole block the moment a
// series ends, so the same pills are also read from `.bodyshot-team` on a
// team profile.
function scrapeRoles(doc) {
  var byId = {};
  var byNick = {};
  var remember = function (id, nick, found) {
    if (!found.length) return;
    if (id) byId[String(id)] = found;
    if (nick) byNick[nickKey(nick)] = found;
  };
  Array.prototype.forEach.call(doc.querySelectorAll('#lineups .player-compare[data-player-id]'), function (el) {
    var found = [];
    if (el.querySelector('.role-pill--igl')) found.push('igl');
    if (el.querySelector('.role-pill--awp')) found.push('awp');
    if (!found.length) return;
    var id = el.getAttribute('data-player-id');
    var nick = txt(el.querySelector('.text-ellipsis'));
    if (!nick) {
      var named = doc.querySelector(
        '#lineups .player-compare.flagAlign[data-player-id="' + id + '"] .text-ellipsis'
      );
      nick = txt(named);
    }
    if (!nick) {
      var img = el.querySelector('img.player-photo');
      var alt = (img && img.getAttribute('alt')) || '';
      var quoted = alt.match(/'([^']+)'/);
      nick = quoted ? quoted[1] : '';
    }
    remember(id, nick, found);
  });
  Array.prototype.forEach.call(doc.querySelectorAll('#lineups a[href*="/player/"]'), function (a) {
    var href = a.getAttribute('href') || '';
    var found = [];
    if (a.querySelector('.role-pill--igl')) found.push('igl');
    if (a.querySelector('.role-pill--awp')) found.push('awp');
    if (!found.length) return;
    var m = href.match(/\/player\/(\d+)\/([^/?#]+)/);
    if (!m) return;
    remember(m[1], m[2], found);
  });
  // Team profile: current roster photos. HLTV strips `#lineups` from a match
  // page the moment the series ends, so the IGL/AWP pills have to come from
  // here instead. The same function is used on both documents.
  Array.prototype.forEach.call(doc.querySelectorAll('.bodyshot-team a[href*="/player/"]'), function (a) {
    var found = [];
    if (a.querySelector('.role-pill--igl')) found.push('igl');
    if (a.querySelector('.role-pill--awp')) found.push('awp');
    if (!found.length) return;
    var href = a.getAttribute('href') || '';
    var m = href.match(/\/player\/(\d+)\/([^/?#]+)/);
    if (!m) return;
    var nick = a.getAttribute('title') ||
      txt(a.querySelector('.nickname-container .text-ellipsis')) || m[2];
    remember(m[1], nick, found);
  });
  return { byId: byId, byNick: byNick };
}

function rolesMissing(roles) {
  if (!roles) return true;
  return !Object.keys(roles.byId || {}).length && !Object.keys(roles.byNick || {}).length;
}

// Match-page pills win when both sources have an entry for the same player.
function mergeRoles(base, extra) {
  var out = { byId: {}, byNick: {} };
  var copy = function (src) {
    if (!src) return;
    Object.keys(src.byId || {}).forEach(function (k) { out.byId[k] = src.byId[k]; });
    Object.keys(src.byNick || {}).forEach(function (k) { out.byNick[k] = src.byNick[k]; });
  };
  copy(extra);
  copy(base);
  return out;
}

function parseLineupStatsAttr(el, attr) {
  if (!el) return {};
  try {
    return JSON.parse(el.getAttribute(attr) || '{}') || {};
  } catch (e) {
    return {};
  }
}

function attachLineupStats(player, data) {
  var row = data && data[String(player.id)];
  if (!row) return player;
  player.rating = row.rating || '';
  player.kpr = row.kpr || '';
  player.dpr = row.dpr || '';
  player.kast = row.kast || '';
  player.adr = row.adr || '';
  player.swing = row.roundSwing || '';
  return player;
}

// Who is actually playing this match, from `#lineups`. The Liquipedia roster
// is the org's current squad and misses a stand-in; this is the five HLTV
// lists under each team. Stats are the last-3-months highlighted numbers
// HLTV already computed for the compare widget (`data-teamN-players-data`).
// Absent on some pages (lineups not yet posted).
function scrapeLineups(doc) {
  var out = [[], []];
  var compare = doc.querySelector('#lineups .lineups-compare-container');
  var stats = [
    parseLineupStatsAttr(compare, 'data-team1-players-data'),
    parseLineupStatsAttr(compare, 'data-team2-players-data')
  ];
  Array.prototype.forEach.call(doc.querySelectorAll('#lineups .lineup'), function (box, i) {
    if (i > 1) return;
    var players = [];
    Array.prototype.forEach.call(
      box.querySelectorAll('td.player:not(.player-image) .player-compare'),
      function (el) {
        var nick = txt(el.querySelector('.text-ellipsis'));
        if (!nick) return;
        players.push(attachLineupStats({
          nick: nick,
          id: parseInt(el.getAttribute('data-player-id') || '0', 10),
          flag: flagCodeFromImg(el.querySelector('img.flag'))
        }, stats[i]));
      }
    );
    players.sort(function (a, b) { return (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0); });
    out[i] = players;
  });
  return out;
}

// The roles a player holds, given whatever identifier is to hand.
function rolesFor(roles, nick, id) {
  if (!roles) return [];
  if (id && roles.byId && roles.byId[String(id)]) return roles.byId[String(id)];
  if (roles.byNick && roles.byNick[nickKey(nick)]) return roles.byNick[nickKey(nick)];
  return [];
}

/*
 * Overtime half scores are only on a map's own stats page, in its round history.
 *
 * Every overtime lives in ONE row per team, however many were played - the match
 * page likewise reports them as a single aggregate, so neither says how many
 * there were. What does say is the `.round-history-bar` dividers: one precedes
 * each half, so a row with four bars is two overtimes and a row with two is one.
 *
 * Every outcome icon that is not "emptyHistory" is a round that team won, and
 * the icon says which side they held: bomb_exploded and t_win are T, while
 * ct_win, bomb_defused (a defusal is a CT win) and stopwatch are CT.
 *
 * Returns one entry per overtime, each [{team, halves: [{side, rounds} x2]} x2].
 */

var CT_ICONS = ['ct_win', 'bomb_defused', 'stopwatch'];
var T_ICONS = ['t_win', 'bomb_exploded'];

function iconName(img) {
  return (img.getAttribute('src') || '').split('/').pop().split('?')[0].replace(/\.\w+$/, '');
}

// Split a row's outcome icons into halves at the bars that precede each one.
// Older pages render no bars, in which case overtime is assumed to be MR3.
function splitHalves(row) {
  var halves = [];
  var current = null;
  Array.prototype.forEach.call(row.children, function (el) {
    if (!el.classList) return;
    if (el.classList.contains('round-history-bar')) { current = []; halves.push(current); return; }
    if (!el.classList.contains('round-history-outcome')) return;
    if (!current) { current = []; halves.push(current); }
    current.push(iconName(el));
  });
  if (halves.length > 1) return halves;

  var icons = halves[0] || [];
  var chunks = [];
  for (var i = 0; i < icons.length; i += 3) chunks.push(icons.slice(i, i + 3));
  return chunks.length ? chunks : halves;
}

function summariseHalf(icons) {
  var won = icons.filter(function (ic) { return ic && ic !== 'emptyHistory'; });
  var side = '';
  won.forEach(function (ic) {
    if (!side && CT_ICONS.indexOf(ic) >= 0) side = 'CT';
    else if (!side && T_ICONS.indexOf(ic) >= 0) side = 'T';
  });
  return { side: side, rounds: won.length };
}

function opposite(side) {
  return side === 'CT' ? 'T' : side === 'T' ? 'CT' : '';
}

// A team that lost every round of a half has no icons there, so its side cannot
// be read off them. It is still knowable: the other team held the opposite side
// that half, and the same team held the opposite side in the other half.
function fillMissingSides(pair) {
  [0, 1].forEach(function (h) {
    var a = pair[0].halves[h], b = pair[1].halves[h];
    if (!a || !b) return;
    if (!a.side && b.side) a.side = opposite(b.side);
    if (!b.side && a.side) b.side = opposite(a.side);
  });
  pair.forEach(function (row) {
    var first = row.halves[0], second = row.halves[1];
    if (!first || !second) return;
    if (!first.side && second.side) first.side = opposite(second.side);
    if (!second.side && first.side) second.side = opposite(first.side);
  });
  return pair;
}

function scrapeOvertimes(doc) {
  var box = doc.querySelector('.round-history-con.round-history-overtime');
  var rows = box
    ? box.querySelectorAll('.round-history-team-row')
    : Array.prototype.slice.call(doc.querySelectorAll('.round-history-team-row'), 2);
  if (!rows || rows.length < 2) return [];

  var teams = [0, 1].map(function (i) {
    var img = rows[i].querySelector('img.round-history-team');
    return {
      team: img ? (img.getAttribute('title') || '') : '',
      halves: splitHalves(rows[i]).map(summariseHalf)
    };
  });

  var count = Math.floor(Math.min(teams[0].halves.length, teams[1].halves.length) / 2);
  var out = [];
  for (var n = 0; n < count; n++) {
    out.push(fillMissingSides(teams.map(function (t) {
      return { team: t.team, halves: t.halves.slice(n * 2, n * 2 + 2) };
    })));
  }
  return out;
}

function scrapePlayerRow(tr) {
  var link = tr.querySelector('td.players a[href*="/player/"]');
  var href = link ? link.getAttribute('href') : '';
  var cell = function (sel) { return txt(tr.querySelector(sel)); };
  return {
    nick: txt(tr.querySelector('td.players .player-nick')) ||
          txt(tr.querySelector('td.players .smartphone-only.statsPlayerName')),
    url: link ? new URL(href, 'https://www.hltv.org').toString() : '',
    id: parseInt((href.match(/\/player\/(\d+)\//) || [])[1] || '0', 10),
    flag: flagCodeFromImg(tr.querySelector('td.players img.flag')),
    kd: cell('td.kd.traditional-data') || cell('td.kd'),
    swing: cell('td.roundSwing'),
    adr: cell('td.adr.traditional-data') || cell('td.adr'),
    rating: cell('td.rating')
  };
}

// Returns [{team, players}, {team, players}] for one stats tab, or null.
function scrapeStatsTab(doc, contentId) {
  var container = doc.getElementById(contentId);
  if (!container) return null;
  var out = [];
  Array.prototype.forEach.call(container.querySelectorAll('table.totalstats'), function (table) {
    var rows = Array.prototype.filter.call(table.querySelectorAll('tr'), function (r) {
      return !r.classList.contains('header-row');
    });
    var players = rows.map(scrapePlayerRow).filter(function (p) { return p.nick; });
    players.sort(function (a, b) { return parseFloat(b.rating) - parseFloat(a.rating); });
    out.push({ team: txt(table.querySelector('.header-row .teamName')), players: players });
  });
  return out.length ? out : null;
}

function scrapeVrs(doc, teams) {
  var wrap = doc.querySelector('.vrs-forecast-container');
  if (!wrap) return null;
  var names = Array.prototype.map.call(
    wrap.querySelectorAll('.vrs-forecast-left .vrs-forecast-team-name'), txt
  );
  var before = wrap.querySelectorAll('.vrs-forecast-left-numbers .vrs-forecast-numbers-wrapper');
  var result = wrap.querySelectorAll('.vrs-forecast-middle .vrs-forecast-numbers-wrapper');
  if (before.length < 2 || result.length < 2) return null;

  var num = function (s) { return parseInt(String(s).replace(/[^0-9-]/g, ''), 10) || 0; };
  var rows = [0, 1].map(function (i) {
    var bPts = num(txt(before[i].querySelector('.vrs-forecast-points')));
    var diff = num(txt(result[i].querySelector('.vrs-forecast-points')));
    return {
      name: names[i] || '',
      beforeRank: txt(before[i].querySelector('.vrs-forecast-ranking')),
      afterRank: txt(result[i].querySelector('.vrs-forecast-ranking')),
      diff: diff,
      total: bPts + diff
    };
  });

  // The widget lists teams in page order, but re-check by name just in case.
  if (names.length === 2 && teams[0] &&
      names[0].toLowerCase() !== teams[0].name.toLowerCase() &&
      names[1].toLowerCase() === teams[0].name.toLowerCase()) {
    rows.reverse();
  }
  return rows;
}

function scrapeMatch(doc, url) {
  var teams = scrapeTeams(doc);
  var live = scrapeLive(doc);
  var maps = markLiveMap(scrapeMaps(doc), live);
  var eventA = doc.querySelector('.timeAndEvent .event a');
  var matchUrl = String(url || '').split('#')[0].split('?')[0];
  var statsByMap = {};
  maps.forEach(function (m) {
    if (m.mapstatsId) statsByMap[m.mapstatsId] = scrapeStatsTab(doc, m.mapstatsId + '-content');
  });
  return {
    matchUrl: matchUrl,
    matchId: (matchUrl.match(/\/matches\/(\d+)\//) || [])[1] || '',
    event: {
      name: (eventA && eventA.getAttribute('title')) || txt(eventA),
      url: eventA ? new URL(eventA.getAttribute('href'), 'https://www.hltv.org').toString() : ''
    },
    teams: teams,
    live: live,
    format: scrapeFormatBox(doc),
    veto: scrapeVeto(doc, teams),
    maps: maps,
    vods: scrapeVods(doc),
    roles: scrapeRoles(doc),
    lineups: scrapeLineups(doc),
    highlights: scrapeHighlights(doc),
    prize: shortPrize(scrapePrize(doc)),
    vrs: scrapeVrs(doc, teams),
    hltvStreams: scrapeHltvStreams(doc),
    statsAll: scrapeStatsTab(doc, 'all-content'),
    statsByMap: statsByMap
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scrapeMatch: scrapeMatch, scrapeOvertimes: scrapeOvertimes, scrapeRoles: scrapeRoles,
    scrapeLineups: scrapeLineups, scrapeLive: scrapeLive, scrapeHltvStreams: scrapeHltvStreams, seriesFromMaps: seriesFromMaps,
    rolesFor: rolesFor, rolesMissing: rolesMissing, mergeRoles: mergeRoles, nickKey: nickKey,
    shortPrize: shortPrize, flagEmoji: flagEmoji, langAnchor: langAnchor,
    teamAnchor: teamAnchor, teamTag: teamTag, flagLink: flagLink, titleCase: titleCase,
    highlightTitle: highlightTitle, txt: txt, flagCodeFromImg: flagCodeFromImg
  };
}
