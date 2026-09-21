# Newsroom embed

A one-line snippet that puts a small copy of Elections Simplified inside a
news article. Readers find their own ballot, read about the races and
candidates, and make their picks, without leaving the page.

## For editors

Paste this where the box should appear:

```html
<script src="https://electionssimplified.com/embed.js"></script>
```

The box opens on our landing page: the address search. It works for any
address in the country. Nothing else is needed.

To choose the size yourself, add either or both of the size settings:

```html
<script src="https://electionssimplified.com/embed.js" data-max-width="560" data-height="600"></script>
```

- `data-max-width` sets the widest the box may be, in pixels (240 to 2000). It is
  optional; without it the box fills the column you put it in. Either way it
  shrinks to fit a narrower screen, so it never overflows a phone.
- `data-height` sets the box's height in pixels (240 to 2000). It is
  optional; without it the box fits its page when it loads (between 380 and
  600 pixels), and re-fits only if the box's width changes, for example when
  a reader rotates their phone. Readers scroll inside it, so nothing they do
  in the box moves the rest of your page.
- `data-publisher="your-code"` is the code we give your newsroom. It lets us
  count how many readers reached the site from your page. It is optional.

If your publishing system strips `<script>` tags, use the iframe form:

```html
<iframe src="https://electionssimplified.com/embed#pub=your-code" title="Find what is on your ballot, from Elections Simplified" style="width:100%;border:0;height:600px"></iframe>
```

Set a height that suits your page; readers scroll inside the box. If neither
form works, link to our home page.

What readers can do in the box: search an address (or a ZIP or city, for a
partial ballot), see the elections they can vote in, open a race and its
candidates, and pick. The first search asks them to accept our Terms of Use,
as on the site. After the first pick a "My Draft" counter appears at the top
right and opens their draft, also inside the box. The draft is kept in the
reader's browser for your site only. A "Save" button on the draft opens a
small prompt; its sign-up link opens our site in a new tab and carries the
picks along, so they are saved to the new account. Follow and Share are not
offered in the box. Every other link (sources, candidate websites, the rest
of our site) opens in a new tab, so your readers keep your page.

Data comes from official candidate lists and public records, researched and
reviewed by hand. Corrections: contact@electionssimplified.com. The content
may be reused freely with attribution.

## How it works

- `frontend/public/embed.js` inserts an iframe of `/embed` after the script
  tag. With `data-height` the box is exactly that tall. Without it, the page
  reports its content height while it loads and the script fits the box to
  it (380 to 600 pixels). Reports are honoured for about 2.5 seconds after
  the first one (styles or fonts can land late), and again for 2.5 seconds
  whenever the box's own width changes (a rotated phone, a resized window),
  since content fitted to the old width would leave the box half empty or
  too short. Nothing the reader does inside the box resizes it. The page scrolls inside the frame,
  so the host page's layout never changes. The message is honoured only
  from our origin and from that iframe's own window.
- `/embed` is `frontend/src/pages/EmbedHomePage.tsx`: the site's landing
  page (`components/LandingHero.tsx`, shared with the home page) outside the
  App layout, with no loader, so one cached copy serves everyone. Framed,
  the search never grabs focus (autofocus would scroll the host page), and
  the big wordmark gives way to a small "Powered by Elections Simplified"
  line at the bottom, which opens the site in a new tab.
- The search is `components/AddressSearchForm.tsx`, the same component the
  home page uses, so the clickwrap, the ZIP and city partial-ballot paths,
  the paid address suggestions, and the usage events are one piece of code.
  A search navigates to `/ballot` inside the frame.
- The box is small, so the ballot list starts compact there: sorted by
  biggest district first, with every section (district levels, vote-power
  bands, retention races, races awaiting candidates) closed. What the reader
  opens or closes rides the list's nav state (`sectionOpen` in
  `lib/detailNavContext.ts`), so coming back from a race or a candidate
  finds the list as they left it. On the site the same sections start open.
- In-box pages: only `/embed` can be loaded in a frame. The ballot, race,
  candidate, and draft pages are reached by client-side navigation and
  render in the normal App layout, which detects the frame
  (`frontend/src/lib/embedSession.ts`) and swaps the site header and footer
  for the box header. A click guard sends every page outside the box to a
  new tab. A third-party frame has no session cookie and its own storage, so
  the reader is always a guest there, and their draft is shared by every
  box on the same publisher's site.
- Save: the frame's storage is separate from the site's, so inside the box
  the sign-up prompt (`RegisterPromptDialog`, opened by the draft's "Save"
  button and by the other account-only actions) puts the picks in the
  sign-up and log-in URLs' fragment, together with the district ids of an
  exact address search made in the box (never the address itself; a ZIP or
  city search carries none, so a partial ballot cannot become an account's
  saved one). A fragment is never sent to a server or in a Referer. On the
  site, `components/DraftHandoffGate.tsx` clears the fragment at once and:
  for a guest (or an unverified account) merges the picks into the site's
  draft, arms the usual guest-to-account district handoff
  (`savePendingDistrictIds`), and leaves the rest to the normal flush after
  sign-up; for a reader who is already signed in, ASKS first, because a link
  must never write into an account by itself, then adds only the races the
  account has not decided. Rows are sanitized, must carry a real (UUID)
  election id, and never replace an existing pick.
- The publisher code rides in the URL fragment, which never reaches the
  server, so the cached page is publisher-neutral. The page reads it in the
  browser (`frontend/src/lib/embedPublisher.ts`) and outbound links carry it
  as `?src=<code>`. Only codes listed in
  `frontend/src/data/embedPublishers.ts` are accepted; add a newsroom's code
  there when we give it to them.
- The Cloudflare router worker drops `X-Frame-Options` and sets
  `frame-ancestors *` for `/embed` only, and edge-caches it for 60 seconds
  like other public pages. Every other page keeps refusing to be framed.
- Attribution: `frontend/src/lib/usage.ts` records an allowlisted publisher
  code as the `source` prop of `session_start`, for both kinds of session: a
  reader working INSIDE a box (the code that box was loaded with) and a
  reader who opened the site from a box (`?src=` on the arrival URL).
  Nothing else from the publisher's page is recorded. This needs usage
  analytics switched on (`USAGE_ANALYTICS_ENABLED`); with it off, nothing is
  recorded for anyone.

## Measuring

- Embeds rendered: Cloudflare request counts for `/embed`.
- Tagged arrivals, guest picks, and account outcomes by publisher: SQL over
  `usage.events`, joining `session_start.props->>'source'` to later events
  in the same `session_id`. A guest who later registers appears in both
  counts; report them separately, not summed.
