# HLTV → r/GlobalOffensive Post-Match Threads

Browser extensions that turn an HLTV match page into a finished
r/GlobalOffensive post-match thread: they scrape the match, render the thread
body in the exact format the Post-Match Team uses, copy it to your clipboard,
and open the reddit submit page with the title filled in and the flair applied.

Two thread formats are supported, each as its own self-contained extension.

| | Format | Extension |
|---|---|---|
| **New** | Liquipedia-enriched: rosters, coaches, social links, event streams, and "advances to … and will face …" from the bracket | [`new_format/extension/`](new_format/extension/) |
| **Old** | HLTV-only: the original layout | [`old_format/extension/`](old_format/extension/) |

Each folder has its own README covering install, data sources, and the
quirks worth knowing. Start there — this page is just the map.

## Layout

```
new_format/
  SampleBody.md            the format spec: a real thread, used as the test oracle
  GeneratedBody.md         the same match rendered by the extension, for comparison
  extension/               the new-format build  (README, src/, tools/)
old_format/
  SampleBody1-3.md         three sample threads
  SampleTitle1-2.txt       sample titles
  extension/               the old-format build  (README, src/, tools/)
globaloffensivecustomcss.css   the subreddit's stylesheet (see below)
```

## Install

Both builds load the same way:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick `new_format/extension` (or `old_format/extension`)
3. Open any finished HLTV match page and click the button bottom-right

They inject the same button, so run one at a time.

## How the format is kept honest

`SampleBody.md` is a real thread, treated as the spec. The renderer is checked
against it with a differ that strips content (names, numbers, links, flags) and
compares only layout — trailing double spaces, `&nbsp;` dividers, pipe
positions, blank lines. The new format currently reproduces it **line for line
(215/215)**, with a documented set of deliberate differences: three defects in
the sample that were fixed on request, and Liquipedia links that have been added
since the sample was written. Those are listed in
[`new_format/extension/README.md`](new_format/extension/README.md).

## Diagnostics

The new-format build logs every run — each fetch with its status and duration,
every cache decision, every parse result, and what the bracket lookup found. A
**Copy diagnostics** button in the panel turns amber on warnings and red on
errors, and the options page keeps the last five runs. That log is the fastest
way to work out why a thread came out incomplete; the extension README explains
how to read one.

## `globaloffensivecustomcss.css`

A copy of the subreddit's public stylesheet, kept because
`tools/build-teams.js` reads it to generate the team → logo-flair table. Refresh
it and re-run that script when the subreddit changes its flairs. It is the
subreddit's work, included here only as a build input.

## Test fixtures

Development used ~115 MB of saved HLTV, Liquipedia, Google and Brave pages as
fixtures. They are not in the repo (see `.gitignore`) — they are third-party page
dumps and trivial to re-save with *Save page as → Web page, single file*.
