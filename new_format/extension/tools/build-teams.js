/* Build the HLTV team name -> r/GlobalOffensive logo-flair table.
 *
 * Inputs: the subreddit stylesheet (pairs a flair class with the anchor a body
 * must link to, e.g. `.flair-fan.flair-liquid, a[href$="#tl-logo"]`) and the
 * Valve ranking page (the team names HLTV actually renders). Only the top 200
 * are considered; a team with no flair is left out and falls back to its
 * country-flag anchor, which is what the sample threads do. */
const fs = require('fs');

const css = fs.readFileSync(__dirname + '/../../globaloffensivecustomcss.css', 'utf8');

const key2slug = new Map();
for (const m of css.matchAll(/([^{}]+)\{/g)) {
  const sel = m[1];
  const anchor = sel.match(/a\[href[*$^]?="#?([a-z0-9._-]+)-logo"\]/);
  if (!anchor) continue;
  for (const f of sel.matchAll(/\.flair-(?:fan|gamer|official|team)\.flair-([a-z0-9._-]+)/g)) {
    if (!key2slug.has(f[1])) key2slug.set(f[1], anchor[1]);
  }
  if (!key2slug.has(anchor[1])) key2slug.set(anchor[1], anchor[1]);
}

// Orgs whose HLTV name shares no substring with the flair the subreddit uses.
const ALIAS = {
  'natus vincere': 'navi',
  'complexity': 'col',
  'gen.g': 'geng',
  'evil geniuses': 'eg',
  'hellraisers': 'hr',
  'dignitas': 'dig',
  'ninjas in pyjamas': 'nip',
  'mouz': 'msports',        // hand-verified against the subreddit's flair list
  'mouz nxt': 'msports',
};

// A first-word match onto the parent org is wrong for these sub-teams; the
// subreddit either has a dedicated flair (which `exact` already finds) or none.
const VARIANT = /\b(academy|junior|juniors|jr|nxt|youngsters|young|prospects|fe|female|women|womens|w|b|ii|2|force|ares|reload|talent|rising)\b/i;

const teams = JSON.parse(fs.readFileSync(__dirname + '/vrs_teams.json', 'utf8'));
const seen = new Set();
const top = [];
for (const t of teams) {
  if (parseInt(t.pos.replace('#', ''), 10) > 200) break;
  if (!seen.has(t.name)) { seen.add(t.name); top.push(t.name); }
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const STOP = /\b(esports|e-sports|gaming|team|club|project)\b/gi;

function resolve(name) {
  const lower = name.toLowerCase().trim();
  if (ALIAS[lower]) return { slug: key2slug.get(ALIAS[lower]) || ALIAS[lower], why: 'alias' };

  const tries = [];
  const add = (v, why) => { if (v && v.length > 1) tries.push({ v, why }); };

  add(norm(name), 'exact');
  const noArticle = name.replace(/^the\s+/i, '');
  add(norm(noArticle), 'no-article');
  const stripped = noArticle.replace(STOP, ' ').replace(/\s+/g, ' ').trim();
  add(norm(stripped), 'no-suffix');

  const words = stripped.split(/[\s.]+/).filter(Boolean);
  const rest = words.slice(1).join(' ');
  if (words.length > 1) {
    const acronym = words.map((w) => norm(w).charAt(0)).join('');
    if (acronym.length >= 3) add(acronym, 'acronym');
    add(norm(words[0]) + words.slice(1).map((w) => norm(w).charAt(0)).join(''), 'first+initials');
    if (!VARIANT.test(rest)) add(norm(words[0]), 'first-word');
  }
  if (!VARIANT.test(rest)) {
    const n = norm(stripped);
    for (const k of key2slug.keys()) {
      if (k.length >= 5 && k.length < n.length && n.startsWith(k)) add(k, 'prefix');
    }
  }

  const hit = tries.find((t) => key2slug.has(t.v));
  return hit ? { slug: key2slug.get(hit.v), why: hit.why } : null;
}

const rows = top.map((name) => ({ name, ...(resolve(name) || { slug: null, why: null }) }));
const matched = rows.filter((r) => r.slug);

console.log('top-200 distinct: ' + top.length + '   matched: ' + matched.length +
            '   unmatched: ' + (rows.length - matched.length) + '\n');
matched.forEach((r) => console.log(
  (r.why === 'exact' ? '    ' : ' !! ') + r.name.padEnd(22) + ' -> #' + r.slug + '-logo' +
  (r.why === 'exact' ? '' : '   [' + r.why + ']')));


/* ---- emit extension/src/teams.js ---- */
const lines = matched.map((r) =>
  "  " + JSON.stringify(r.name.toLowerCase()) + ": " + JSON.stringify(r.slug) + "," +
  (r.why === 'exact' ? '' : '   // ' + r.name + '  [' + r.why + ']'));

const heuristic = matched.filter((r) => r.why !== 'exact').length;
const out = `/*
 * HLTV team name -> r/GlobalOffensive logo-flair slug. Pure data plus a lookup;
 * pmt.js decides what to render when a team is missing.
 *
 * GENERATED - do not hand-edit. Regenerate with:
 *     node tools/build-teams.js
 * after refreshing the subreddit stylesheet or the ranking snapshot. Built by
 * pairing each flair class with its anchor in the subreddit stylesheet (e.g.
 * \`.flair-fan.flair-liquid, a[href$="#tl-logo"]\`) and matching those flair
 * classes against the Valve ranking's top 200 team names.
 *
 * Entries are exact name matches unless a trailing comment names the rule that
 * produced them - those ${heuristic} are the ones worth an eyeball.
 *
 * A team that is NOT here has no subreddit flair and renders with its country
 * or region anchor instead (\`[EU flag](#lang-eu)\`), exactly as the sample
 * threads do for magic and MOUZ.
 *
 * ${matched.length} of the ranking's top 200 (${top.length} distinct names) have a flair.
 */
var TEAM_LOGO_FLAIRS = {
${lines.join('\n')}
};

// The flair slug for a team, or null when the subreddit has no logo for it.
function teamFlairSlug(name, overrides) {
  var key = String(name || '').trim().toLowerCase();
  return (overrides && overrides[key]) || TEAM_LOGO_FLAIRS[key] || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TEAM_LOGO_FLAIRS: TEAM_LOGO_FLAIRS, teamFlairSlug: teamFlairSlug };
}
`;
fs.writeFileSync(__dirname + '/../src/teams.js', out);
console.log('\nwrote extension/src/teams.js with ' + matched.length + ' entries');
