# Newsroom embed

A one-line snippet that lets a news site show the full list of November races
for one city, pulled live from Elections Simplified, with links back to the
candidate and measure pages and to the address lookup.

## For editors

Paste this where the box should appear:

```html
<script src="https://electionssimplified.com/embed.js" data-city="austin-tx" data-publisher="your-code"></script>
```

- `data-city` is the code we give you. A city code like `austin-tx` shows
  every race that touches that city. A two-letter state code like `tx` shows
  only the statewide races and measures, for a statewide guide.
- `data-publisher` is the code we give your newsroom. It lets us count how
  many readers reached the site from your page. It is optional.

If your publishing system strips `<script>` tags, use the iframe form:

```html
<iframe src="https://electionssimplified.com/embed/city/austin-tx#pub=your-code" title="Election races for this city, from Elections Simplified" style="width:100%;border:0;height:600px"></iframe>
```

The iframe form does not resize itself; set a height that suits your page.
If neither works, link to the plain page: `https://electionssimplified.com/cities/austin-tx`.

What the box shows: every race that touches the city (or, for a state code,
the statewide races) for the reviewed election date, grouped by level (Federal, State, County, City, Ballot
measures), each group collapsed until the reader opens it. For each
candidate: name, party where the race is partisan, incumbent status, and
withdrawn status, plus the site's vote-power rating for the race. For each
measure: a short description and what a yes and a no vote mean, in our
words, not the ballot text.

Every link in the box opens our site in a new tab, so your readers keep
your page.

The box is a city-wide overview, not a ballot. A city spans many districts
that belong to different voters, so the box says so and offers "Find my races
and build my ballot," which opens the address lookup on our site.

Data comes from official candidate lists and public records, researched and
reviewed by hand before a city is added. Corrections: contact@electionssimplified.com.
The content may be reused freely with attribution.

## How it works

- `frontend/public/embed.js` inserts an iframe of `/embed/city/<slug>` after
  the script tag and grows it to fit, honouring height messages only from our
  origin and from that iframe's own window.
- The publisher code rides in the URL fragment, which never reaches the
  server, so one cached copy of the page serves every publisher. The page
  reads it in the browser and appends `?src=<code>` to its outbound links.
- `/embed/city/:slug` and `/cities/:slug` share one module,
  `frontend/src/pages/EmbedCityPage.tsx`. The loader is server-side: it calls
  `/api/ballot?district_ids=…&election_date=…&sort=vote_power&include=preview`,
  pinned to the reviewed election date (so the list outlives the API's
  recent-past window), and returns a trimmed race list, so the HTML is
  complete without a client fetch.
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
