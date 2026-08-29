# HLTV → r/GlobalOffensive Post-Match Thread — new format

Chrome/Edge extension, same button and reddit flow as the old-format one, but it
renders the new thread layout and pulls event, team and bracket detail from
Liquipedia.

The old-format build is kept unchanged at `../../old_format/extension/` (and its
working copy at `../../extension/`). The two are independent — load whichever you
want, or both, though they inject the same button so run one at a time.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → pick this `extension/` folder.
3. Open any HLTV match page and click the button bottom-right.

## What it fetches

Everything comes off the match page unless listed here.

| Fetch | Why |
|---|---|
| HLTV event page | the venue for the Setting line, and a name → flag directory used to give the next bracket opponent a flag |
| HLTV map stats page | **only for maps that went to overtime** — the match page reports OT as a single aggregate (`(4:2)`), and the per-half split the format needs is in the round history |
| Search ×3 | locating the Liquipedia event and team pages — Google, falling back to Brave |
| Liquipedia event page | stream links, and the bracket for "advances to … and will face …" |
| Liquipedia team pages ×2 | full team name, social links, roster, coach, benched players |

**Only the search lookups are cached.** The HLTV↔Liquipedia mapping is stored in
`chrome.storage.local` keyed by the HLTV URL and kept indefinitely, so a team is
searched for once and never again. Page *contents* are always re-read, so a
thread can never be built from a stale roster, prize pool or ranking.

The three resolved Liquipedia URLs appear in the panel. Editing one and hitting
**Regenerate** uses it and writes it to the cache — which is also the fallback if
search ever fails or returns the wrong article. **Clearing** a box and hitting
Regenerate forgets the remembered page and searches again from scratch, exactly
as if the team were being seen for the first time; reloading the same saved link
is the one thing emptying the box cannot have meant.

## Why everything goes through a background tab

Both sources refuse a service-worker fetch, for different reasons:

| Source | Response | Reason |
|---|---|---|
| Liquipedia | 403, 2059 bytes, "Verify you are human" | needs the clearance cookie it hands out after you pass the check in a browser |
| Google / Brave | Brave: 429, "your browser does not seem to have JavaScript enabled"; Google: a redirect to `/sorry/` | a captcha, which needs a page's JavaScript to run |

The Liquipedia half was proven by fetching one URL twice from the same page at
the same moment: `credentials: 'include'` returned 200/380 KB, `credentials:
'omit'` returned 403/2059 bytes. The search half cannot be fixed by any fetch at
all — no fetch runs JavaScript.

So a background tab does the work. It is a real browser: it has the cookies, it
runs the scripts, and it looks like the user because it *is* the user. One tab is
opened lazily (inactive), shared for the whole run, and closed when the run goes
idle. If a Liquipedia tab is already open it is borrowed and left alone.

- **Searches** navigate the tab and read the results after the page's scripts
  have run. They are serialised and spaced 1.2s apart. Google is asked first and
  Brave only if it comes back empty or blocked (`via`: `google-tab` /
  `brave-tab`) — see below.
- **Liquipedia pages** try a plain credentialed fetch first, since that is much
  quicker when the cookie travels, and drop to the tab the moment that comes
  back as anything other than the article. The read escalates through three
  rungs and stops at the first that returns a real page:

  | Rung | `via` | Notes |
  |---|---|---|
  | worker fetch | `worker` | fastest; works only when the clearance cookie travels |
  | tab fetch | `tab-fetch` | same-origin, from inside the tab — skipped unless the tab is already on liquipedia.net |
  | tab navigation | `tab-navigate` | the tab simply goes to the page, exactly as you would |

  The escalation is deliberately blind to *why* a rung failed, because the
  failure modes look nothing alike: a Cloudflare challenge is a 403 with a
  captcha in it, a school or office web filter is usually a **200 serving its
  own block page**, and a DNS blackhole is no response at all — the fetch just
  throws. Each of those drops to the next rung.

  A 200 is therefore not taken at face value: the body has to carry MediaWiki's
  markers (`mw-parser-output` and friends) to count as the article. That check
  is for what a Liquipedia page *has* rather than for what a block page *says* —
  a blocklist of filter vendors' wording would both miss the next filter and
  fire on an article that happens to quote one. An intercepted response is
  logged with `"intercepted": true` and an excerpt of whatever answered instead,
  rather than being parsed into a thread with an empty roster in it.

Search results are cached forever, so a repeat run performs **zero** searches —
which is the main defence against being rate-limited in the first place.

The run log records the route every request took (`"via"`: `worker`, `tab-fetch`,
`tab-navigate`, `google-tab`, `brave-tab`) and, on a fallback, what triggered it —
`"retriedAfter"` for the worker fetch that was abandoned, `"afterTabFetch"` for
a tab fetch that was skipped past.

### Liquipedia's own search is not used

It looked tempting — no captcha, and its "go" jump resolves `Vitality` straight
to `Team_Vitality`. But it resolves `Spirit` to `/counterstrike/Spirit`, which is
a **player** page, and it ranked FaZe Clan first for "IEM Beijing 2026 Open
Qualifier". Wrong-but-plausible is the worst failure mode available here, because
the thread still renders — just with the wrong team's roster in it. A general
search engine was correct on every case tested, so a search engine it is.

### Google first, Brave second

Brave is right about the teams everyone has heard of and gets worse as they get
smaller — which is the wrong way round, since an obscure org is exactly the one
nobody proofreading the thread will catch. Google was correct on the obscure
cases (`yawara` → `Yawara_E-Sports`, `FOKUS` → `FOKUS`), so it is asked first.

Brave is kept rather than deleted because Google is the stricter of the two about
automation: a captcha there must not take the whole run down. A blocked engine is
detected (a redirect to `/sorry/`, `consent.google.com`, or a body that talks
about unusual traffic) and recorded in the trace as `"blocked": true`, which is
worth telling apart from a genuine miss — a captcha means *ask someone else*,
an empty result means this name will not be found by asking twice.

**Neither engine's markup is parsed.** Naming the classes a result is built from
is what makes SERP scraping rot, and Google's are generated (`.PMDqCb`,
`.NMq1me`, different next month). But only *one* link is ever needed, so the
markup can be ignored: collect every anchor in the results column and keep the
first that points at a Counter-Strike article. That rule is identical on both
engines, which is why one extractor serves both — and it is markedly sturdier
than the `.result-content > a` it replaced, which returned nothing the moment
Brave reshuffled. The only ids used are `#rso` / `#search` / `#center_col`, and
only to scope the scan; Brave has none of them and falls through to the body.

One wrinkle that scoping earns its keep on: in the saved `yawara` page the first
Liquipedia link on the page is an invisible zero-text anchor outside `#rso`.

**A team-shaped URL is preferred.** A team lives at a single path segment
(`Team_Spirit`, `K27`, `FOKUS`, `Yawara_E-Sports`) while tournaments nest
(`European_Pro_League/Series_6/Play-In`, `Fiesta_Series/1`). So a team lookup
passes over a nested article in favour of a flat one further down the results.
It is a preference rather than a filter — if nothing flat turns up the best
candidate is still returned, and the page it lands on is checked before anything
is built from it.

**Tab subpages are demoted.** Google ranks a team's `/Matches` and `/Results`
pages as results in their own right, so `FOKUS/Results` can outrank `FOKUS`.
Those are the same article one level down, and the parent is the one with the
roster on it, so a known tab suffix is stripped. Event pages are nested too
(`Esports_World_Cup/2026`), which is why the tabs are named explicitly rather
than any trailing segment being treated as a subpage.

### The page has to be the right kind of page

A search can hand back a page that is not the thing asked for, and none of the
parsers will complain: a tournament page has an infobox with a name and social
links in it, so it parses cleanly into a team that never existed. `Bebop` once
resolved to European Pro League Series 6 Play-In, and the thread went out
listing that tournament as one of the teams, wearing the tournament's Twitter
and Twitch. It renders perfectly. It is just wrong — which is the failure mode
worth spending code on, because nothing about the output looks broken.

Liquipedia labels the infobox with what the page is, so that is the whole check:

| Header | Page |
|---|---|
| `Team Information` | a team |
| `League Information` | a tournament |
| `Player Information` | a player |

The categories at the foot of the page (`Teams`, `Tournaments`, `Players`) are
kept as a second opinion for pages carrying no infobox at all. That only ever
matters for events, whose streams and bracket are read from the body — a team
page with no infobox has no name and no links to give, so there is nothing to
rescue. Matching there is anchored to the *end* of the category, because a
tournament is also filed under `Team Tournaments`.

**The page must prove what it is.** A page that matches nothing is rejected, not
allowed through. The permissive rule sounds like the careful one and is not: it
let `/counterstrike/Qualifier_Tournaments` — an index page, no infobox, no
roster — print as a team called "Qualifier Tournaments". Nothing is lost by
insisting, since a page with no team infobox has nothing to contribute anyway.

A page of the wrong kind is **discarded, not used**: the thread falls back to
HLTV's name and flag, the run log says what was found instead, and the panel
says so in words — `Liquipedia link for Bebop was a tournament page (European
Pro League Series 6 Play-In), ignored`. The bad URL is dropped from the cache
too, or every future run would repeat the mistake.

Wiki plumbing is filtered out one step earlier, when results are picked:
`Category:`, `Template:`, `Special:` and friends are not articles. The saved
FOKUS results carry a `Template:Team_Vitality_Roster_Navbox` link, which was
eligible before. Namespaces are listed by name rather than excluding anything
with a colon in it, because a real article is allowed one
(`Counter-Strike:_Global_Offensive`).

Teams that genuinely have no Liquipedia page — which is most of the field in an
open qualifier — land where they always did: `no Liquipedia page for X`, and a
thread built from HLTV alone.

## Details worth knowing

**Overtime columns.** `|Team|T|CT|OT1^CT:T|OT2^T:CT|Total|` — one column per
overtime played, its header naming the sides that team held across the two
halves, and `2:1` under it meaning 2 rounds won in the first half and 1 in the
second.

Working out how many overtimes there were takes some care. The match page
aggregates them all into one figure (`(7:5)`), and the map stats page puts every
overtime in a *single* row per team however many were played. The
`.round-history-bar` dividers are what give it away: one precedes each half, so a
row with four bars is two overtimes. Splitting on the bars rather than assuming a
length also copes with a half of unusual size. Pages that render no bars fall
back to MR3.

Every outcome icon that is not `emptyHistory` is a round that team won, and the
icon names the side: `bomb_exploded` and `t_win` are T; `ct_win`, `stopwatch` (a
CT win on the timer) and `bomb_defused` (a defusal is a CT win) are CT.

A team that loses *every* round of a half leaves no icons there, so its side
cannot be read directly. It is still knowable: the opponent held the opposite
side that half, and the same team held the opposite side in the other half. Both
inferences are applied, which is what turns OG's `^:T` into `^CT:T`.

**Roles.** `♛` in-game leader, `⊕` main AWPer, from HLTV's `#lineups` role pills.
A player can hold both — cadiaN captains OG *and* AWPs for them — so every pill
is rendered, in the order HLTV lists them: `cadiaN ♛ ⊕`.

Matching a pill to a player is fiddlier than it looks, because the same person
arrives under three spellings: HLTV's URL slug drops punctuation (`hunter`),
HLTV's stats tables keep it (`huNter-`), and Liquipedia has its own. Roles are
therefore indexed by HLTV player id *and* by a nick folded to letters and digits;
the id wins wherever there is one, and Liquipedia's roster — which carries no
HLTV ids — falls back to the folded nick.

**Team names across sources.** Liquipedia's bracket says "FUT Esports" where
HLTV says "FUT". Looking a team up in the HLTV event directory ignores the org
words (`Esports`, `Gaming`, `Team`, `Club`), and the HLTV spelling is the one
carried forward, since that is what the subreddit flair table is keyed on.

**Who counts as a player.** Liquipedia's roster table has one column for both
support staff ("Coach", "Analyst") and qualifiers that still describe a playing
member ("Loan", "Stand-in", "Trial"). Only staff titles disqualify someone —
treating every label as staff dropped OG's two loaned-in players, who had just
played the match. Coaches are pulled from the same column by name.

**Links reddit will not have.** r/GlobalOffensive's spam filter autoremoves a
post that links to Russian social media, Telegram or Discord, and it removes the
*whole* thread over one link — a CIS team's infobox routinely carries three, so
Spirit's thread would never have survived its own Team Information line. Those
links are dropped before they reach the body; everything else on the line keeps
its order, and the run log names what went.

Two rules decide, because neither signal covers the other's ground. A link is
dropped if Liquipedia tagged it `lp-vk`, `lp-telegram` or `lp-discord` — the
icon is what catches a Discord invite behind a vanity redirect like `dsc.gg` or
a team's own subdomain. It is also dropped on its host: any `.ru` domain, or
`vk.com` / `vk.cc` / `vkplay.live` / `t.me` / `telegram.me` / `telegram.org` /
`discord.gg` / `discord.com`. That half is what catches the link no icon marks
— a blocked link is as often the Official Site as it is the VK one. `.ru` as a
rule covers vk.ru, vkvideo.ru, ok.ru and rutube.ru without naming them, so only
the networks sitting on other TLDs are listed.

**Bracket.** The match is found by team names plus score; its parent match gives
both the round name and the opponent.

Finding the round name is the fiddly part, because a bracket is not one column
list. A double-elimination group is rendered as several *sections*, each with its
own header row followed by its trees:

```
.brkts-bracket
  .brkts-round-header    Upper Bracket QF | Upper Bracket SF | Qualified
  .brkts-round-body      (upper bracket trees)
  .brkts-round-header    Lower Bracket QF | Lower Bracket SF | Qualified
  .brkts-round-body      (lower bracket trees)
```

So a match's column is counted back from *its own section's* last playable
column, and trailing "Qualified" columns are skipped — they are qualification
slots, not rounds. Counting them was what made an upper bracket quarter-final
report that its winner advanced to "Qualified".

Team names are compared both verbatim and with org words dropped, so the bracket
still resolves when HLTV says "Falcons" and Liquipedia says "Team Falcons" —
including when the Liquipedia team page failed to load and only HLTV's spelling
is available.

A section final (winning the upper bracket, say) has no parent match, so the
"advances to" line is omitted rather than guessed at. Same for a grand final.

**Team names.** The header and Team Information use Liquipedia's full name
("Team Vitality"); the VRS table, veto table and stats tables use HLTV's short
one ("Vitality"). That is what the sample does.

## Deviations from `../SampleBody.md`

The renderer reproduces the sample line-for-line (215 lines) except for 36 lines
in five deliberate categories:

| Difference | Why |
|---|---|
| `𖦏` → `⊕` (20 lines) | requested fix; the sample's AWP glyph is U+1698F, a Miao vowel sign |
| `Team Spirit Spirit` → `Team Spirit` (1) | the sample concatenates the Liquipedia and HLTV names |
| `#spiritw-logo` → `#spirit-logo` (1) | the veto table's sample anchor is the *women's* team flair; every other line in the sample uses `#spirit-logo` |
| a stray `\t ` line (1) | dropped; Maps 1 and 3 have a plain blank line there |
| parenthesised asides stripped from highlights (6) | requested fix |
| extra social links (2) | Liquipedia lists two networks it did not when the sample was made — Facebook for Vitality, Bilibili for Spirit |

The sample's `NaN` after Spirit's last link is gone.

**One judgement call in the paren stripping.** HLTV splits some plays across
several clips and only a `(Part 1 - observer)` / `(Part 2 - REPLAY…)` marker
tells them apart, so stripping every aside left two identical links side by side.
Asides that begin with "Part" are kept; everything else goes. Say the word and
it strips those too.

**Also unreproduced, deliberately:** the sample's full-match-stats separator row
has six cells for five columns (`|:--|--:|--:|--:|--:|--:|`). That one *is*
copied verbatim — reddit ignores the extra cell, and it is what the format emits.

## Diagnostics

Every run is logged: each fetch with its status, byte count and duration; each
cache hit or miss; each parse result with counts (`roster: 5, coaches: 1`); and
what the bracket lookup searched for and found. On a failed fetch the log also
carries the response headers and a 400-character text excerpt of the body —
which is where Liquipedia and Cloudflare put the reason for a 403.

Nothing sensitive is recorded: public page URLs, element counts, and error
messages. Page contents are never logged beyond sizes and that failure excerpt.

**Getting a log out:**

- **Copy diagnostics** in the panel copies the run you just did. The button
  shows a count and turns amber on warnings, red on errors, so a thread that is
  quietly missing its team information is obvious before you post it.
- The **options page** keeps the last five runs, newest first, each with Copy
  and Show. Use this when you notice a problem after closing the tab.
- Everything is also in the page's devtools console, prefixed `[PMT]`.

The panel's status line already names what is missing in plain words, e.g.
`Body copied. Missing: Liquipedia event (HTTP 403); Liquipedia Spirit (HTTP 403).`

**Options page also has "Forget Liquipedia links"** — the link cache never
expires, so this is how a wrong search result gets undone. It only removes the
`lp:` keys, not your settings.

## Panel, options, reddit

Same as the old-format build: title, highlights and body are all editable,
**Regenerate** re-renders without re-opening reddit, and the submit page opens as
a text post with the title filled in and the `Discussion | Esports` flair applied.
See `../../old_format/extension/README.md` for the flair selectors and the
generated `src/teams.js` flair table.
