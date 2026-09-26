# Address Autocomplete — Frontend Contract

The backend proxies Google Places (New) autocomplete behind two endpoints so
the frontend never talks to Google directly: the API key stays server-side, the
browser never calls Google (so the user's browser IP never reaches Google —
only the backend's does), and the provider is swappable server-side. Note the
typed address text **is** forwarded to Google to fetch suggestions; proxying
hides the key and the user's IP, not the address input itself.
This document is the complete contract for implementing the typeahead input in
the frontend repo.

## Endpoints

Both require `Content-Type: application/json`. Both return the standard error
envelope `{ "error": { "code", "message" } }` on failure.

### POST /api/address/autocomplete

Request:

```json
{ "input": "1600 Penn", "session_token": "0aa2ee7a-8f0f-4b3f-9c53-1b6f9d6a2f11" }
```

- `input`: 3–200 chars after trimming. Shorter input → 400; don't call until
  the user has typed 3+ characters.
- `session_token`: 8–128 chars of `[A-Za-z0-9_-]`. Use a UUIDv4
  (`crypto.randomUUID()`).

Response `200`:

```json
{
  "suggestions": [
    {
      "place_id": "ChIJGVtI4by3t4kRr51d_Qm_x58",
      "description": "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA",
      "main_text": "1600 Pennsylvania Avenue NW",
      "secondary_text": "Washington, DC 20500, USA"
    }
  ]
}
```

`suggestions` may be empty. Render `main_text` bold with `secondary_text`
muted (or just `description`).

### POST /api/address/autocomplete/retrieve

Call once when the user picks a suggestion.

Request:

```json
{ "place_id": "ChIJGVtI4by3t4kRr51d_Qm_x58", "session_token": "0aa2ee7a-8f0f-4b3f-9c53-1b6f9d6a2f11" }
```

Response `200`:

```json
{ "address": "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA" }
```

### Errors (both endpoints)

- `400 invalid_request` — bad input/token; treat as "no suggestions".
- `429 rate_limited` — honor the `retry-after` header; stop firing requests.
- `500 internal_error` "Address autocomplete is not configured" — the backend
  has no Google key; hide the dropdown entirely and fall back to plain input.
- `502 bad_upstream_response` / `503 upstream_unavailable` — Google hiccup;
  show no dropdown, let the user keep typing. Never block manual entry.

## Session token lifecycle (billing-relevant)

How Google bills under the Maps Platform pricing in force since March 2025
(checked against Google's price list on 2026-09-25):

- A session that ends in a Place Details retrieve bills **nothing** for its
  autocomplete requests. The Autocomplete Session Usage SKU is free with no
  monthly limit. The terminating Place Details Essentials request is billed:
  10,000 free per month, then $5 per 1,000. Our retrieve field mask
  (`formattedAddress,location,types,addressComponents`) stays in the
  Essentials tier; adding Pro or Enterprise fields would raise the price.
- An abandoned entry (the user never picks a suggestion, so no retrieve
  terminates the session) bills **every** suggest request under the
  Autocomplete Requests SKU: 10,000 free per month, then $2.83 per 1,000.
- Requests with no session token, or with a reused token, bill the same way
  as an abandoned entry.

So a completed entry costs one Place Details call, and abandoned entries are
the cost driver. Overage is pay-as-you-go on the linked Google Cloud billing
account; service never stops at the free tier unless a daily cap is set under
the project's Places API (New) quotas.

Always send a session token: it is what makes the completed-entry keystrokes
free, and reused tokens are treated as no-session.

- Generate a fresh `crypto.randomUUID()` when the user **starts** an address
  entry (first keystroke that triggers a suggest call).
- Send the **same** token on every suggest call and the final retrieve for
  that entry.
- After a retrieve completes — or the user clears the field and starts over —
  the session is dead. Generate a new token for the next entry. Never reuse.

## Input behavior

- Minimum 3 characters. Leading-edge fire: the first suggest of an entry (no
  live session token — also covers pasting) goes out immediately; subsequent
  keystrokes debounce ~125 ms after the last keystroke, matching the latency
  Google's own widget targets. Cost note: at average typing speed this fires
  roughly one suggest per keystroke. Those are free when the entry ends in a
  retrieve and billed per request when it is abandoned (see above), and
  aborting the browser request does not stop a backend→Google call already
  in flight. Watch the Autocomplete Requests SKU after changing the debounce.
- On input focus, fire one throwaway invalid suggest request (empty `input`).
  The server 400s it before touching Google, so it costs nothing, but it warms
  the TLS connection, the CORS preflight cache, and the backend before the
  first real keystroke. A not-configured 500 on the warmup disables the
  dropdown for the session early.
- Cancel in-flight requests when a new one fires (`AbortController`) and
  ignore out-of-order responses.
- Selecting a suggestion: call retrieve, put the returned `address` string
  into the input, then run the **existing** flow unchanged:
  - anonymous: `POST /api/address/resolve` with
    `{ "address": ..., "accepted_terms_version": TERMS_VERSION }` — the
    clickwrap is enforced server-side, so the version is required
  - logged-in: `PUT /api/me/address` with `{ "address": ... }` (no clickwrap
    field: the account already carries its acceptance)
- Autocomplete failing must never block the form — the input stays a plain
  text field that submits to the same endpoints.
- Use an ARIA combobox pattern (`role="combobox"`, `aria-expanded`,
  `aria-activedescendant`, arrow-key navigation, Escape to close) or a
  maintained headless component — don't hand-roll keyboard handling.

## Compliance

- Show **"powered by Google"** attribution on the suggestions dropdown
  (required when predictions are displayed without a Google map).
- Do not store, cache, or log suggestions or retrieved addresses beyond the
  current entry session (Google ToS). Persist only the app's own output: the
  resolved districts from `/api/address/resolve` / `/api/me/address`.
