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
| Brave search ×3 | locating the Liquipedia event and team pages |
| Liquipedia event page | stream links, and the bracket for "advances to … and will face …" |
| Liquipedia team pages ×2 | full team name, social links, roster, coach, benched players |

**Only the Brave lookups are cached.** The HLTV↔Liquipedia mapping is stored in
`chrome.storage.local` keyed by the HLTV URL and kept indefinitely, so a team is
searched for once and never again. Page *contents* are always re-read, so a
thread can never be built from a stale roster, prize pool or ranking.

The three resolved Liquipedia URLs appear in the panel. Editing one and hitting
**Regenerate** uses it and writes it to the cache — which is also the fallback if
Brave ever fails or returns the wrong article.

## Why everything goes through a background tab

Both sources refuse a service-worker fetch, for different reasons:

| Source | Response | Reason |
|---|---|---|
| Liquipedia | 403, 2059 bytes, "Verify you are human" | needs the clearance cookie it hands out after you pass the check in a browser |
| Brave | 429, "your browser does not seem to have JavaScript enabled" | a captcha, which needs a page's JavaScript to run |

The Liquipedia half was proven by fetching one URL twice from the same page at
the same moment: `credentials: 'include'` returned 200/380 KB, `credentials:
'omit'` returned 403/2059 bytes. The Brave half cannot be fixed by any fetch at
all — no fetch runs JavaScript.

So a background tab does the work. It is a real browser: it has the cookies, it
runs the scripts, and it looks like the user because it *is* the user. One tab is
opened lazily (inactive), shared for the whole run, and closed when the run goes
idle. If a Liquipedia tab is already open it is borrowed and left alone.

- **Searches** navigate the tab and read the results after the page's scripts
  have run. They are serialised and spaced 1.2s apart.
- **Liquipedia pages** try a plain credentialed fetch first, since that is much
  quicker when the cookie travels, and drop to the tab the moment a challenge
  comes back. Inside the tab, if it is already on liquipedia.net the page is
  read with a same-origin fetch; otherwise the tab navigates to it.

Search results are cached forever, so a repeat run performs **zero** searches —
which is the main defence against being rate-limited in the first place.

The run log records the route every request took (`"via"`: `worker`, `tab-fetch`,
`tab-navigate`, `brave-tab`) and, on a fallback, what triggered it.

### Liquipedia's own search is not used

It looked tempting — no captcha, and its "go" jump resolves `Vitality` straight
to `Team_Vitality`. But it resolves `Spirit` to `/counterstrike/Spirit`, which is
a **player** page, and it ranked FaZe Clan first for "IEM Beijing 2026 Open
Qualifier". Wrong-but-plausible is the worst failure mode available here, because
the thread still renders — just with the wrong team's roster in it. Brave was
correct on every case tested, so Brave it is.

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
| extra social links (4) | Liquipedia now lists networks it did not when the sample was made — nothing is dropped, only added |

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
