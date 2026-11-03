# OOOhm marketing site

The public landing page for OOOhm: one static page (`index.html`, `styles.css`, `app.js`) with
recordings of the real app in `media/`. There's no build step and no dependencies.

It lives apart from the app on purpose. The app is installed once per company, is invite-only, and
answers `/` with the signed-in person's home screen, so a marketing page has no place inside it.
Keeping the site static also means it can go on any host without the app's database or secrets.

## Preview

```bash
python3 -m http.server 4100 -d site   # then open http://localhost:4100
```

## Deploy

The site lives at **https://ooohm.team**, on its own Vercel project (`ooohm-site`) with **Root Directory**
`site`. `vercel.json` turns the build off and serves the folder as is; `.vercelignore` leaves out `demo/`,
the tooling that made the media. Any other static host works too: serve the folder as is.

`og:image`, `og:url` and the canonical link in `index.html` name the domain, since link previews ignore
relative URLs. Change all three if the site moves.

## What's on the page

- **The request sentence** (hero): a working copy of the app's sentence form. It counts working days
  on the demo company's calendar (Monday to Friday, minus its 2026–27 US holidays) and draws the balance squares.
  It plays a few examples until someone touches it.
- **The tour** (`media/tour.mp4`): a 46-second film, rendered from `demo/film.html`, built around the
  recordings below.
- **Four recordings** (`media/ask.mp4`, `approve.mp4`, `calendar.mp4`, `team.mp4`): the real app,
  driven by Playwright with demo data.
- **A year of PTO**, **approve from the email** with its audit row, the **Needs you** list, a
  **webhook stream** and a **`docker compose up`** terminal: small coded animations of real behaviour.
- **Theme stills** (`media/themes/*.jpg`): the home screen in each of the nine company themes.

Everything respects `prefers-reduced-motion`: animations settle on their last state and the videos
show controls instead of playing on their own.

## Re-recording the media

The people and requests are fictional (Northwind Studio). With Postgres running and the app built:

```bash
# .env: SEED_ADMIN_EMAIL=maya@example.com, SEED_ADMIN_NAME="Maya Chen", SEED_COMPANY_NAME="Northwind Studio",
# a local DATABASE_URL, OOOHM_BACKGROUND=inline. The clips are dated around Nov 3, 2026.
pnpm db:migrate && pnpm db:seed
pnpm exec tsx --env-file=.env site/demo/demo-data.mts   # resets the demo requests; local databases only
pnpm build && pnpm start          # in a second terminal; wait until http://localhost:3000 answers
node --env-file=.env site/demo/record.mjs   # every clip, then the theme stills (or name some: ask approve themes)
node site/demo/render-film.mjs       # the tour, from the clips
```

The scripts use the preinstalled Playwright (`NODE_PATH=$(npm root -g)` if it's installed globally),
`ffmpeg`, and `psql` (the Postgres client). `--env-file=.env` points the recorder's `psql` calls at
the app's `DATABASE_URL`. Sign-in goes through the real magic-link flow, reading the token from the local database.
Run `demo-data.mts` again before `record.mjs ask approve`, since those clips change requests as they go.

## Fonts

Instrument Sans and JetBrains Mono, both under the SIL Open Font License 1.1, are served from `fonts/`
so the page makes no third-party requests.
