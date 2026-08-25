# HLTV → r/GlobalOffensive Post-Match Thread

Chrome/Edge extension. On any finished HLTV match page it adds a **Post-Match Thread**
button; one click renders the thread in the sample format, copies the body to your
clipboard, and opens `old.reddit.com/r/GlobalOffensive/submit` as a text post with the
title filled in and the flair set.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → pick this `extension/` folder.
3. Open any HLTV match page and click the button bottom-right (or the toolbar icon).

## Where each part of the thread comes from

Everything below is read from the match page itself unless the row says otherwise.

| Thread section | Source |
|---|---|
| Title (`A vs B / Event - Stage / Post-Match Discussion`) | `.teamsBox`, `.event a[title]`, first bullet of the format box (title-cased: `Grand final` → `Grand Final`) |
| Header line, series score, per-map scores, `~~unplayed~~` | `.teamsBox`, `.mapholder` |
| "X advances to …" | the format box's `Winner advances to …` sentence with the winner's name substituted; omitted when there is no such sentence (grand finals) |
| **Setting** — prize pool | `.matchSidebarDataContainer` → "Prizepool" (`$2,000,000` → `$2m`; `Other` → omitted) |
| **Setting** — venue | *event page* `td.location` (`Paris, France` → Paris; `Europe (Online)` → Europe) |
| **Setting** — LAN/Online | the format box (`Best of 5 (LAN)`) |
| Predicted VRS impact | `.vrs-forecast-container`; lineup IDs from the stats table; ranking date from the `/valve-ranking/teams` redirect |
| Map picks | the veto list, in HLTV's order |
| Full match stats + per-map stats | `#all-content` / `#<mapstatsid>-content` |
| Half scores, incl. the `**OT**` column | `.results-center-half-score` |
| Detailed-stats + VOD links | `.results-center-stats a`, `.streams [data-stream-embed]` (Twitch player URLs rewritten to `twitch.tv/videos/…?t=…`) |
| Highlights | `.highlights .highlight[data-highlight-embed]`, clip URLs rewritten to `clips.twitch.tv/<slug>`; editable in the panel |

Highlight text drops every parenthesised aside and keeps the surrounding whitespace, so
`4 AK kills (3 HS) on the bombsite A offensive (1vs2 post-plant clutch)` becomes
`4 AK kills  on the bombsite A offensive ` — the double and trailing spaces in the samples
are the gaps those asides left behind. Nothing else is trimmed.

Two requests are made per thread — the event page (venue) and `/valve-ranking/teams`
(ranking date). **Nothing is cached**: a thread can never be built from a prize pool or
ranking date that has since moved.

**No clicking through map tabs is needed.** HLTV ships every map's stats table in the
initial HTML and the tab buttons only toggle `display`, so `#<mapstatsid>-content` is
readable straight away. (Verified by diffing the saved `ALL_MAPS` page against the
`MAP_1/2/3` pages: the only differences are `style="display:none|block"` and a `bold`
class.)

## Team logos and flags

A team's flag links to its subreddit logo flair — `[🇩🇰](#astralis-logo)`. When the
subreddit has no flair for that team it links to the country/region anchor instead —
`[🇪🇺](#lang-eu)` — which is what the sample threads do for `magic`, `MOUZ` and `Acend`.

`src/teams.js` is **generated**. `tools/build-teams.js` pairs each flair class with its
anchor in the subreddit stylesheet (`.flair-fan.flair-liquid, a[href$="#tl-logo"]`) and
matches those against the Valve ranking's top 200 team names. 53 of the top 200 have a
flair; the 14 that were not exact name matches carry a trailing comment naming the rule
that produced them, so they can be audited.

Regenerate after the subreddit stylesheet or the ranking changes:

```bash
node tools/build-teams.js
```

It expects `globaloffensivecustomcss.css` in the parent folder and `tools/vrs_teams.json`
(a `[{pos, name}]` dump of `hltv.org/valve-ranking/teams`).

HLTV's region pseudo-flags map to `EU → 🇪🇺 #lang-eu`, `SAM`/`NAM` → `🌎 #lang-earth`,
`ASIA` → `🌏`, `WORLD` → `🌍`; the subreddit only has an EU icon and a generic globe.

## Reddit submit page

The URL carries `selftext=true` so old.reddit opens on the text-post tab, and the flair
name in the fragment (`#pmt-flair=…`, so it never reaches the server or the posted URL).
A second content script on `old.reddit.com/r/*/submit*` reads it and performs the three
clicks the picker needs:

| Step | Default selector |
|---|---|
| open the picker | `.flairselect-btn` |
| pick the flair | `.linkflair.linkflair-discussion.linkflair-esports > .linkflairlabel` |
| apply it | `#newlink-flair-dropdown > form > button` |

The last two are configurable in options; if the flair selector matches nothing, the
script falls back to matching the flair *name* against the picker's `.linkflairlabel`s,
then a `<select>`, then any flair-ish element with that text. It polls for 10s, then
gives up. A toast in the corner of the submit page reports which path was taken.

The apply click is the one place a wrong selector could do damage — clicking the post's
own submit button would publish the thread before the body is pasted. So it refuses to
click any button whose form is `#newlink` or contains the title/text fields, whatever the
selector says.

## Panel

Generating opens a panel with the title, the highlights, and the body. Edit anything,
then **Regenerate** (re-renders without re-opening reddit), **Copy body**, or
**Open reddit submit**. While the highlights box is untouched, HLTV's own text is used
verbatim — including the whitespace left by the stripped parenthesised asides. Editing
the box switches to the typed lines instead.

## Options

`chrome://extensions` → Details → Extension options: subreddit, post flair
(default `Discussion | Esports`, empty to skip), the two flair selectors above, whether
to auto-open the submit page, and per-team logo-flair overrides.

## Format fidelity

The renderer is checked against `SampleBody1/2/3.md` with a skeleton differ that strips
content (names, numbers, links, flags) and compares only layout — trailing double spaces,
`&nbsp;` dividers, pipe positions, blank lines. Sample 2 matches line-for-line (120/120);
every distinct line shape across all three samples is reproduced, including the `**OT**`
column and the no-flair fallback.
