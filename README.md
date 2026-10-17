# M2020 Events (M2020 Event Swiper)

An unofficial, Tinder-style session picker for **Money20/20 USA 2026** (Oct 18–21, The Venetian Expo, Las Vegas).
Swipe through the agenda, save the sessions you want, then add all of them to your calendar in one go.

Live: [https://m2020.pages.dev](https://m2020.pages.dev). It is not affiliated with Money20/20.

## Features

- **Swipe deck**: swipe right (or tap Save, or press →) to save; swipe left (Skip, ←) to skip. One-step undo
  (the Undo button, Z, Backspace or Cmd/Ctrl+Z). Mobile-first, works one-handed, and also works with a keyboard and mouse.
- **Readable cards**: day, format, time in Pacific Time with duration, room plus summit and building, a floor-map
  link for every room, the full description in paragraphs, topics and speakers.
- **Filters before you swipe**: day, stage/venue (grouped), session type, theme, topic tag, and a text search over
  titles, speakers, companies and job titles. Counts update live, active filters show as removable chips above the
  deck, and filters are remembered on this device.
- **Saved list**: grouped by day, with Remove (and Undo).
- **Add everything to your calendar at once** (see below). Every event is marked *free* and *tentative*, so it never
  blocks your work calendar, and there are no reminders.
- In-app toasts and a confirm dialog (no browser pop-ups). Respects reduced motion. Light and dark theme (follows your device, or pick one in the menu).

## Adding sessions to a calendar

The **Add to calendar** dialog offers one link per calendar app. Each link points at a calendar feed that lists
every saved session:

| Option | Link format |
|---|---|
| Google Calendar (personal or Google Workspace) | `https://calendar.google.com/calendar/render?cid=webcal://m2020.pages.dev/api/calendar/<ids>.ics` |
| Outlook, work or school (Microsoft 365) | `https://outlook.office.com/calendar/0/addfromweb?url=<feed>&name=Money20/20 picks` |
| Outlook.com, personal | `https://outlook.live.com/calendar/0/addfromweb?url=<feed>&name=Money20/20 picks` |
| Apple Calendar (iPhone, iPad, Mac) | `webcal://m2020.pages.dev/api/calendar/<ids>.ics` |
| Anything else | copy the feed link (`https://m2020.pages.dev/api/calendar/<ids>.ics`) |

How it works:

- `<ids>` is the list of saved session IDs, compactly encoded in the URL: sorted, base-36, delta-encoded and
  joined with `.` (`M2020Calendar.encodeIds`). All 311 sessions fit in about 650 characters.
- The feed is served by a Cloudflare Pages Function (`functions/api/calendar/[feed].js`, which shares its code
  with `functions/api/calendar.js`). It fetches the official agenda, falls back to the bundled snapshot if that
  fails, and returns `text/calendar`.
- The calendar app adds the feed as its own calendar named **"Money20/20 picks"**. You can color it, hide it,
  or delete every pick in one step. No Google or Microsoft API, OAuth or app registration is involved, so it
  works with company Google Workspace and Microsoft 365 accounts unless an admin blocks adding calendars by URL.
- Limits:
  - Google only lets you add a calendar by URL from a computer browser, not from its phone app. On phones the
    dialog explains this and offers copy buttons.
  - Google refreshes subscribed calendars roughly once a day.
  - The feed holds the sessions saved when you added it. After saving more, add it again and delete the older
    calendar.
- **Download .ics file** is the fallback. Before importing, create a separate "Money20/20" calendar and import
  into that one, so everything stays color-coded and can be removed together.

Each event has:

- `STATUS:TENTATIVE` and `TRANSP:TRANSPARENT` (shown as free), and no `VALARM`.
- Times in `America/Los_Angeles`.
- A full `LOCATION`: room (summit), building, and street address. Off-site venues get their own address.
- The floor map as `URL`.
- A plain-text description laid out for Google Calendar: WHERE (with the floor-map link), WHEN and FORMAT
  first, then the description, speakers and topics.

## Privacy

Your picks and filters stay in this browser (`localStorage`). The app only goes online to fetch the schedule
and, when you use a calendar link, the IDs of your saved sessions go to m2020.pages.dev in the feed URL. Nothing
else leaves your device. There is no analytics, no account and no tracking.

## Running it

- Open `index.html` directly. Over `file://` the app falls back to the bundled schedule snapshot, and calendar
  links point at the production site.
- Or serve the folder statically, e.g. `npx serve .` (the `/api` routes will 404 and the snapshot is used).
- With the Pages Functions (live schedule + calendar feed), run from the repo root:
  `npx wrangler pages dev . --port 8788`.

There is no build step and nothing is installed. Deploys happen automatically to Cloudflare Pages from `main`.

## Project layout

| File | What it does |
|---|---|
| `index.html` | App shell, icon sprite, overlay mount points, script order |
| `styles.css` | Design tokens and app styles (card, deck, sheets, saved list, About) |
| `core.js` | Shared data layer: schedule mapping, dates/times, HTML to text, escaping (browser and Workers) |
| `venues.js` | Venue resolver: room, area, building, street address, floor-map link, filter groups |
| `calendar.js` | `.ics` builder, compact ID encoding, subscribe links (browser and Workers) |
| `filters.js` / `filters.css` | Filters sheet, active-filter strip, filter persistence |
| `export-ui.js` / `export.css` | "Add to calendar" dialog |
| `toast.js` / `toast.css` | Toasts and the confirm dialog |
| `app.js` | Loading, deck and swipe physics, keyboard, saved list, menu, focus and modal handling |
| `events-data.js` | Bundled schedule snapshot (generated, do not edit) |
| `functions/api/schedule.js` | `GET /api/schedule`, a proxy for the official agenda API (which sends no CORS headers) |
| `functions/api/calendar.js`, `functions/api/calendar/[feed].js` | `GET /api/calendar/<ids>.ics` (also `?ids=`), the calendar feed |

## Scripts

- `./scripts/update-snapshot.sh` refreshes `events-data.js` from the official agenda API.
- `node --check <file>.js` checks syntax. Run it on every JS file you touch.

## Data and storage

- Schedule: `https://us.money2020.com/api/schedule?siteName=money2020-us&search=&agendaType=default`
  (311 sessions). All times are local Pacific Time.
- `localStorage` keys (all prefixed `event-swiper-`):

  | Key | Contents |
  |---|---|
  | `selected` | Saved sessions |
  | `processed-ids` | Sessions already swiped |
  | `sessions-v2` | Schedule cache |
  | `filters` | Filter state |
  | `hint-dismissed` | First-run hint seen |

  Keys from older versions are migrated or removed on load.
