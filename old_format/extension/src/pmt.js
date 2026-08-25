/*
 * pmt.js - scrapes an HLTV match page and renders the r/GlobalOffensive
 * post-match thread title + body.
 *
 * Pure with respect to the network: everything it needs beyond the match page
 * itself (event location/prize, current VRS ranking date) is passed in via
 * `extra`. content.js fetches those and hands them over.
 *
 * Whitespace matters. Reddit's markdown needs a trailing double space for a
 * hard line break, and the sample threads this was built against are
 * reproduced byte-for-byte, so the odd-looking "  \n" / " &nbsp; " literals
 * below are deliberate. SEP is the divider used between top-level sections.
 */

var SEP = '\n\n &nbsp; \n\n';

// Renders one section from its lines. A line ending in whitespace is a
// markdown hard break, so it keeps its own terminating newline before the
// section divider - that is where the "extra" blank line in the samples
// comes from.
function section(lines) {
  var s = lines.join('\n');
  return /[ \t]$/.test(s) ? s + '\n' : s;
}

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

// The anchor a team's flag emoji links to: its logo flair when the subreddit
// has one, otherwise the team's country/region anchor.
function teamAnchor(name, flagCode, overrides) {
  var slug = teamFlairSlug(name, overrides);
  return slug ? '#' + slug + '-logo' : langAnchor(flagCode);
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
    maps.push({
      name: name,
      played: played,
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

// HLTV publishes its own clip highlights on match pages that have them.
//
// The thread drops every parenthesised aside and keeps the surrounding
// whitespace as-is, which is where the samples' double and trailing spaces come
// from - e.g. "4 AK kills (3 HS) on the bombsite A offensive (1vs2 post-plant)"
// becomes "4 AK kills  on the bombsite A offensive ". Nothing else is trimmed.
function highlightTitle(text) {
  return String(text).replace(/\([^)]*\)/g, '');
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
  var maps = scrapeMaps(doc);
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
    format: scrapeFormatBox(doc),
    veto: scrapeVeto(doc, teams),
    maps: maps,
    vods: scrapeVods(doc),
    highlights: scrapeHighlights(doc),
    prize: shortPrize(scrapePrize(doc)),
    vrs: scrapeVrs(doc, teams),
    statsAll: scrapeStatsTab(doc, 'all-content'),
    statsByMap: statsByMap
  };
}

/* --------------------------------------------------------------- rendering */

function buildTitle(data) {
  var a = data.teams[0], b = data.teams[1];
  var stage = data.format.stage;
  return a.name + ' vs ' + b.name + ' / ' + data.event.name +
    (stage ? ' - ' + stage : '') + ' / Post-Match Discussion';
}

function teamTag(team, logoOf) {
  return '[' + flagEmoji(team.flag) + '](' + logoOf(team.name, team.flag) + ')';
}

function statsTable(groups, teams, logoOf) {
  var out = [
    'Team | K-D | ADR | Swing | Rating  ',
    ':--------|:--------:|:--------:|:--------:|:--------:  '
  ];
  groups.forEach(function (g, i) {
    out.push(teamTag(teams[i], logoOf) + ' **' + teams[i].name + '** |  ');
    g.players.forEach(function (p) {
      out.push(
        flagLink(p.flag) + ' [' + p.nick + '](' + p.url + ') | ' +
        p.kd + ' | ' + p.adr + ' | ' + p.swing + ' | ' + p.rating + ' |   '
      );
    });
  });
  return out.join('\n');
}

function mapScoreTable(map, teams, logoOf) {
  var t1 = [], t2 = [];
  map.halves.forEach(function (x, i) { (i % 2 === 0 ? t1 : t2).push(x); });

  var hasOt = map.hasOt;
  var otA = map.ot[0];
  var otB = map.ot[1];
  var side = function (arr, i, fallback) { return arr[i] ? (arr[i].side || fallback) : fallback; };
  var rounds = function (arr, i) { return arr[i] ? arr[i].rounds : 0; };

  var dash = hasOt
    ? '|:--------|:--------:|:--------:|:--------:|:--------:|  '
    : '|:--------|:--------:|:--------:|:--------:|  ';

  return [
    '| Team | **' + side(t1, 0, 'CT') + '** | **' + side(t1, 1, 'T') + '** |' +
      (hasOt ? ' **OT** |' : '') + ' Total |  ',
    dash,
    '|' + teamTag(teams[0], logoOf) + ' **' + teams[0].name + '** | ' +
      rounds(t1, 0) + ' | ' + rounds(t1, 1) + ' |' + (hasOt ? ' ' + otA + ' |' : '') +
      ' ' + map.score[0] + ' |  ',
    '| | **' + side(t2, 0, 'T') + '** | **' + side(t2, 1, 'CT') + '** |' +
      (hasOt ? ' **OT** |' : '') + ' |  ',
    '|' + teamTag(teams[1], logoOf) + ' **' + teams[1].name + '** | ' +
      rounds(t2, 0) + ' | ' + rounds(t2, 1) + ' |' + (hasOt ? ' ' + otB + ' |' : '') +
      ' ' + map.score[1] + ' |'
  ].join('\n');
}

function buildBody(data, extra) {
  extra = extra || {};
  var logoOf = function (name, flag) { return teamAnchor(name, flag, extra.logoOverrides); };
  var t1 = data.teams[0], t2 = data.teams[1];
  var sections = [];

  /* --- header: teams, series score, per-map scores --- */
  var head = [
    '## [' + t1.name + '](' + t1.url + ') ' + teamTag(t1, logoOf) + ' ' +
    '[' + t1.score + '-' + t2.score + '](' + data.matchUrl + ') ' +
    teamTag(t2, logoOf) + ' [' + t2.name + '](' + t2.url + ')   '
  ];
  data.maps.forEach(function (m) {
    head.push(m.played
      ? '**' + m.name + ':** ' + m.score[0] + '-' + m.score[1] + '  '
      : '**~~' + m.name + '~~**  ');
  });
  sections.push(section(head));

  /* --- what the result means, e.g. "X advances to the playoffs." --- */
  var winner = t1.won ? t1 : t2;
  var loser = t1.won ? t2 : t1;
  var outcome = ['  ', '  '];
  data.format.outcomeSentences
    .filter(function (s) { return /\b(winner|loser)\b/i.test(s); })
    .forEach(function (s) {
      outcome.push('**' + s.replace(/\bWinner\b/g, winner.name)
                           .replace(/\bLoser\b/g, loser.name) + '**');
    });
  sections.push(section(outcome));

  /* --- setting + predicted VRS impact --- */
  var meta = [];
  var setting = extra.setting;
  if (setting && setting.place) {
    var bits = [data.prize || setting.prize, data.format.venue].filter(Boolean).join(' ');
    meta.push('**Setting**: ' + flagLink(setting.flag) + ' ' + setting.place +
      (bits ? ' (' + bits + ')' : '') + '  ');
    meta.push('  ');
  }
  if (data.vrs && data.statsAll) {
    var date = extra.vrsDate || '';
    var base = 'https://www.hltv.org/valve-ranking/teams';
    meta.push('### Predicted [VRS](' + base + (date ? '/' + date : '') + ') Impact  ');
    meta.push('Team | Rank | Diff | Total  ');
    meta.push(':--------|:--------:|:--------:|:--------:  ');
    data.vrs.forEach(function (row, i) {
      var ids = ((data.statsAll[i] || {}).players || [])
        .map(function (p) { return p.id; })
        .sort(function (a, b) { return a - b; })
        .join(',');
      var href = base + '/details' + (date ? '/' + date : '') + '?lineup=' + ids;
      var diff = (row.diff >= 0 ? '+' : '') + row.diff + ' pts';
      meta.push(
        teamTag(data.teams[i], logoOf) + ' [**' + data.teams[i].name + '**](' + href + ') | ' +
        row.beforeRank + ' → ' + row.afterRank + ' | ' + diff + ' | ' + row.total + ' pts |  '
      );
    });
    meta.push('  ');
    meta.push(
      '^Note: ^VRS ^officially ^updates ^once ^per ^month. ^This ^is ^simply ^a ^prediction ' +
      '^that ^might ^not ^take ^into ^account ^all ^factors ^that ^go ^into ^VRS ^calculations.'
    );
  }
  if (meta.length) sections.push(section(meta));

  /* --- map picks --- */
  if (data.veto.length) {
    var picks = [
      '### Map picks:  ',
      '| ' + t1.name + ' | **MAP** | ' + t2.name + ' |  ',
      '|:--------:|:--------:|:--------:|  '
    ];
    data.veto.forEach(function (v) {
      var mark = v.action === 'removed' ? '**X**' : v.action === 'picked' ? '**✔**' : '';
      var left = v.side === 0 && mark ? ' ' + mark + ' ' : ' ';
      var right = v.side === 1 && mark ? ' ' + mark + ' ' : ' ';
      picks.push('|' + left + '| ' + v.map + ' |' + right + '|  ');
    });
    sections.push(section(picks));
  }

  /* --- full match stats --- */
  if (data.statsAll) {
    sections.push(section(
      ['# Full Match Stats:  '].concat(statsTable(data.statsAll, data.teams, logoOf))
    ));
  }

  /* --- per-map breakdown --- */
  var playedMaps = data.maps.filter(function (m) { return m.played && m.mapstatsId; });
  if (playedMaps.length) {
    var blocks = playedMaps.map(function (m, i) {
      var groups = data.statsByMap[m.mapstatsId];
      var b = ['## Map ' + (i + 1) + ': ' + m.name + '  ']
        .concat(mapScoreTable(m, data.teams, logoOf))
        .concat(['', '&nbsp;  ', '']);
      if (groups) b = b.concat(statsTable(groups, data.teams, logoOf));
      b.push('  ');
      var vod = data.vods[i];
      b.push('## [' + m.name + ' detailed stats](' + m.statsUrl + ')' +
        (vod ? ' and [VOD](' + vod + ')' : '') + '  ');
      return section(b);
    });
    sections.push(section(['# Individual Map Stats:  ']) + blocks.join(SEP));
  }

  /* --- highlights (HLTV only publishes these for some events) --- */
  var highlights = extra.highlights && extra.highlights.length ? extra.highlights : data.highlights;
  if (highlights && highlights.length) {
    sections.push(section(['# Highlights  '].concat(highlights.map(function (h) {
      return '##### [' + h.title + '](' + h.url + ')  ';
    }))));
  }

  sections.push(
    '[**This thread was created by the Post-Match Team.**]' +
    '(https://docs.google.com/spreadsheets/d/1k5TiV7VuDKLa41MfcDgP1XiBkPvAo_HInRmNlKKEIBM/edit?usp=sharing)  \n' +
    'If you want to share any feedback or have any concerns, please message u/CS2_PostMatchThreads.'
  );

  return sections.join(SEP);
}

function buildThread(doc, url, extra) {
  var data = scrapeMatch(doc, url);
  return { data: data, title: buildTitle(data), body: buildBody(data, extra) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scrapeMatch: scrapeMatch, buildTitle: buildTitle, buildBody: buildBody,
    buildThread: buildThread, shortPrize: shortPrize, flagEmoji: flagEmoji,
    titleCase: titleCase, normalizeVod: normalizeVod,
    scrapeHighlights: scrapeHighlights, highlightTitle: highlightTitle, scrapePrize: scrapePrize,
    teamAnchor: teamAnchor, langAnchor: langAnchor
  };
}
