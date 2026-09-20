# Newsroom embed

A one-line snippet that puts a small copy of Elections Simplified inside a
news article. Readers find their own ballot, read about the races and
candidates, and make their picks, without leaving the page.

## For editors

Paste this where the box should appear:

```html
<script src="https://electionssimplified.com/embed.js"></script>
```

The box opens on our landing page: the address search. Nothing else is
needed. Optional settings:

- `data-publisher="your-code"` is the code we give your newsroom. It lets us
  count how many readers reached the site from your page.
- `data-city="austin-tx"` opens the box on that city's race list instead
  (every race that touches the city), with the same address search above it.
  A two-letter state code like `tx` lists only the statewide races and
  measures. City and state codes are added as we finish reviewing them; an
  unknown code shows "City not available".

To choose the size yourself, add either or both of the size settings:

```html
<script src="https://electionssimplified.com/embed.js" data-max-width="560" data-height="600"></script>
```

- `data-max-width` sets the widest the box may be, in pixels (240 to 2000). It is
  optional; without it the box fills the column you put it in. Either way it
  shrinks to fit a narrower screen, so it never overflows a phone.
- `data-height` sets the box's height in pixels (240 to 2000). It is
  optional; without it the box fits its first page once when it loads
  (between 420 and 600 pixels). Either way the box never changes height
  after that: readers scroll inside it, so nothing they do moves the rest of
  your page.

If your publishing system strips `<script>` tags, use the iframe form:

```html
<iframe src="https://electionssimplified.com/embed#pub=your-code" title="Find what is on your ballot, from Elections Simplified" style="width:100%;border:0;height:600px"></iframe>
```

Set a height that suits your page; readers scroll inside the box.
If neither works, link to our home page, or to a city's plain page: `https://electionssimplified.com/cities/austin-tx`.

With a city code, the box shows every race that touches the city (or, for a state code,
the statewide races) for the reviewed election date, grouped by level
(Federal, State, County, City, Ballot measures), each group collapsed until
the reader opens it. Every load starts that way, so the box is the same
height on every load. What a reader opens is remembered only while they move
around inside the box. Each group is a list of race titles, like the site's own
election list. A race opens its own page: the candidates (name, party,
incumbent and withdrawn status), or for a measure a short description and
what a yes and a no vote mean, in our words, not the ballot text. Judicial
retention questions are left out.

The list is city-wide: every race that touches the city, so each reader can
find theirs. Above it is the same address search as our home page. A reader
who enters an address (or a ZIP or city, for a partial ballot) gets their own
ballot inside the box, with only the races they can vote in; the draft
counter then counts their ballot, not the city's. The first search asks them
to accept our Terms of Use, as on the site.

The box works as a small copy of the site. Races and candidates open
inside the box, with the site's own Back / Prev / Next bar. Readers can pick
candidates; after the first pick a "My Draft" counter appears at the top
right and opens their draft, also inside the box. The draft is kept in the
reader's browser for your site only. A "Save" button on the draft opens a
small prompt; its sign-up link opens our site in a new tab and carries the
picks along, so they are saved to the new account. Follow and Share are not offered in the
box. Every other link (sources, candidate websites, the rest of our site)
opens in a new tab, so your readers keep your page.

The box is a city-wide overview, not a ballot. A city spans many districts
that belong to different voters.

Data comes from official candidate lists and public records, researched and
reviewed by hand before a city is added. Corrections: contact@electionssimplified.com.
The content may be reused freely with attribution.

## How it works

- `frontend/public/embed.js` inserts an iframe of `/embed` (the landing
  page, `pages/EmbedHomePage.tsx`, which shares `LandingHero` with the home
  page) or, with a city code, of `/embed/city/<slug>`, after
  the script tag. With `data-height` the box is exactly that tall. Without
  it, the page reports its content height once and the script fits the box
  to it (420 to 600 pixels), ignoring anything later. The page scrolls
  inside the frame, so the host page's layout never changes. The message is
  honoured only from our origin and from that iframe's own window.
- The publisher code rides in the URL fragment, which never reaches the
  server, so one cached copy of the page serves every publisher. The page
  reads it in the browser and appends `?src=<code>` to its outbound links.
- `/embed/city/:slug` and `/cities/:slug` share one module,
  `frontend/src/pages/EmbedCityPage.tsx`. The loader is server-side: it calls
  `/api/ballot?district_ids=…&election_date=…&sort=vote_power`,
  pinned to the reviewed election date (so the list outlives the API's
  recent-past window), and returns a trimmed race list, so the HTML is
  complete without a client fetch.
- In-box pages: only `/embed` and `/embed/city/*` can be loaded in a frame. Candidate,
  race, and draft pages are reached by client-side navigation and render in
  the normal app layout, which detects the frame
  (`frontend/src/lib/embedSession.ts`) and swaps the site header and footer
  for the box header. A click guard sends every page outside the box to a
  new tab. A third-party frame has no session cookie and its own storage, so
  the reader is always a guest there. The site only offers picks once it
  knows the reader's districts; inside the frame the city's districts stand
  in, so the draft counts against the city's contested races. That context
  is pinned in the frame's memory (`pinDraftBallotContext`), not stored:
  every box on one publisher's site shares the same storage, and a stored
  context would let one city's box replace another's. Picks stay shared.
- Address search: the city list renders `AddressSearchForm` (the landing
  page's own form, compact variant), so the clickwrap, the partial-ballot
  paths, and the usage events are the same code. `/ballot` is an in-box
  path. A ballot the reader loads is their own: it is stored like on the site
  (`setDraftBallotContext` also ends a city's pinned stand-in), so the next
  box on the same publisher's site already knows it (`hasOwnBallot`): a
  city list stops pinning its stand-in, and the draft page returns to that
  ballot. Suggestions use the same paid
  autocomplete endpoint as the site.
- Save: the frame's storage is separate from the site's, so inside the box
  the sign-up prompt (`RegisterPromptDialog`, opened by the draft's "Save"
  button and by the other account-only actions) puts the picks in the
  sign-up and log-in URLs' fragment, together with the district ids of an
  exact address search made in the box (never the address itself; a ZIP or
  city search carries none, so a partial ballot cannot become an account's
  saved one). On arrival the districts arm the site's usual guest-to-account
  district handoff (`savePendingDistrictIds`). The picks travel as a fragment
  (`draftHandoffFragment`; a fragment is never sent to a server or in a
  Referer). The app merges them into the site's draft for guests only
  (`importDraftHandoff`: sanitized, never replaces an existing pick), clears
  the fragment, and the usual flush replays the draft into the account after
  sign-up.
  The in-box draft page keeps the list's scope (`isEmbedListedRace`): the
  reviewed election day only, no retention questions.
- The Cloudflare router worker drops `X-Frame-Options` and sets
  `frame-ancestors *` for `/embed/city/*` only, and edge-caches both routes
  for 60 seconds like other public pages.
- Arrival attribution: `frontend/src/lib/usage.ts` records an allowlisted
  `?src=` code as the `source` prop of `session_start`. Nothing else from the
  query string is read.

## Adding or withdrawing a city

Cities and states are listed in `backend/manual-research/major-cities/embed-pilot.json`.
A state entry has the same fields minus `slug` and `name`; its code is the
lower-case state abbreviation and it resolves to the statewide district only.

```json
{
  "publishers": ["your-code"],
  "states": [
    {
      "state": "TX",
      "election_date": "2026-11-03",
      "review_date": "2026-09-16",
      "official_source_url": "https://www.sos.state.tx.us/elections/",
      "enabled": true
    }
  ],
  "cities": [
    {
      "slug": "austin-tx",
      "name": "Austin",
      "state": "TX",
      "election_date": "2026-11-03",
      "review_date": "2026-09-16",
      "official_source_url": "https://www.sos.state.tx.us/elections/",
      "enabled": true
    }
  ]
}
```

1. Confirm the city has no open roster or deferral units in
   `npm run manual:city-coverage:report`, then review every race for the
   election date against the official candidate list. Record the date and
   source URL.
2. Run `npm run embed:pilot-manifest` in `backend/`. It resolves the city's
   district ids from the database and writes
   `frontend/src/data/embedPilotCities.ts`. It fails if any mapped district is
   missing from the database or the city needs more than 50 district ids.
   Districts that cover under 1% of the city are boundary slivers and are
   left out; the script prints each one. Check that list, and pass
   `--min-share <0-1>` if a real district was dropped.
3. Commit both files and deploy the frontend.

To withdraw a city, set `enabled` to `false`, regenerate, deploy, and purge
`/embed/city/<slug>` and `/cities/<slug>` in the Cloudflare cache. The page
then returns 404 and the box shows "City not available."

After the election date passes, the box keeps the list (the lookup is
pinned to that date) and shows "This election has passed." It never rolls
to a different election on its own.

## Measuring

- Embeds rendered: Cloudflare request counts for `/embed/city/*`.
- Tagged arrivals, guest picks, and account outcomes by publisher: SQL over
  `usage.events`, joining `session_start.props->>'source'` to later events
  in the same `session_id`. A guest who later registers appears in both
  counts; report them separately, not summed.
