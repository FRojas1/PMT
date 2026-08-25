/*
 * HLTV team name -> r/GlobalOffensive logo-flair slug. Pure data plus a lookup;
 * pmt.js decides what to render when a team is missing.
 *
 * GENERATED - do not hand-edit. Regenerate with:
 *     node tools/build-teams.js
 * after refreshing the subreddit stylesheet or the ranking snapshot. Built by
 * pairing each flair class with its anchor in the subreddit stylesheet (e.g.
 * `.flair-fan.flair-liquid, a[href$="#tl-logo"]`) and matching those flair
 * classes against the Valve ranking's top 200 team names.
 *
 * Entries are exact name matches unless a trailing comment names the rule that
 * produced them - those 14 are the ones worth an eyeball.
 *
 * A team that is NOT here has no subreddit flair and renders with its country
 * or region anchor instead (`[EU flag](#lang-eu)`), exactly as the sample
 * threads do for magic and MOUZ.
 *
 * 53 of the ranking's top 200 (192 distinct names) have a flair.
 */
var TEAM_LOGO_FLAIRS = {
  "spirit": "spirit",
  "falcons": "falcons",
  "fut": "fut",
  "mouz": "msports",   // MOUZ  [alias]
  "legacy": "legacy",
  "furia": "furia",
  "vitality": "vitality",
  "9z": "9z",
  "natus vincere": "navi",   // Natus Vincere  [alias]
  "g2": "g2",
  "faze": "faze",
  "betboom": "betboom",
  "aurora": "aurora",
  "big": "big",
  "the mongolz": "mongolz",   // The MongolZ  [no-article]
  "b8": "b8",
  "astralis": "astralis",
  "mibr": "mibr",
  "liquid": "tl",
  "gamerlegion": "gamerleg",   // GamerLegion  [prefix]
  "tyloo": "tyloo",
  "ninjas in pyjamas": "nip",   // Ninjas in Pyjamas  [alias]
  "heroic": "heroic",
  "jijiehao": "jijie",   // JiJieHao  [prefix]
  "100 thieves": "100t",   // 100 Thieves  [first+initials]
  "lynn vision": "lynn",   // Lynn Vision  [first-word]
  "pain": "pain",
  "fnatic": "fnatic",
  "luminosity": "lg",
  "3dmax": "3dmax",
  "m80": "m80",
  "wildcard": "wildcard",
  "flyquest": "flyquest",
  "nrg": "nrg",
  "nemiga": "nemiga",
  "fluxo": "fluxo",
  "metizport": "metiz",   // Metizport  [prefix]
  "imperial": "imperial",
  "9ine": "9ine",
  "og": "og",
  "thunder downunder": "thunder",   // THUNDER dOWNUNDER  [first-word]
  "eternal fire": "eternalfire",
  "ground zero": "groundzero",
  "ence": "ence",
  "the huns": "thehuns",
  "passion ua": "passion",   // Passion UA  [first-word]
  "isurus": "isurus",
  "keyd stars": "keyd",   // Keyd Stars  [first-word]
  "havu": "havu",
  "mouz nxt": "msports",   // MOUZ NXT  [alias]
  "red canids": "redcanids",
  "chinggis warriors": "chinggis",   // Chinggis Warriors  [first-word]
  "rare atom": "rareatom",
};

// The flair slug for a team, or null when the subreddit has no logo for it.
function teamFlairSlug(name, overrides) {
  var key = String(name || '').trim().toLowerCase();
  return (overrides && overrides[key]) || TEAM_LOGO_FLAIRS[key] || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TEAM_LOGO_FLAIRS: TEAM_LOGO_FLAIRS, teamFlairSlug: teamFlairSlug };
}
