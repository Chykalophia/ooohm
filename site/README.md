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

The site lives at **https://ooohm.team**, on its own Vercel project (`ooohm-site`). Its settings live in
the project, not in a `vercel.json`, because the app's `vercel.json` sits at the repository root:

- Root Directory: none, so branches without `site/` can be skipped instead of failing.
- Install Command: `true` (nothing to install).
- Build Command: `rm -rf site/demo site/README.md`, which only leaves out the recording tooling and this file.
- Output Directory: `site`.
- Ignored Build Step: `[ -d site ] || exit 0; [ -n "$VERCEL_GIT_PREVIOUS_SHA" ] || exit 1; git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- site`,
  so a push deploys only when something under `site/` changed since the last deployment (and always
  when there is no earlier deployment to compare with).
  A branch without `site/` never deploys, so to retire the site, remove the domain or the Vercel project
  rather than deleting the folder.

Any other static host works too: serve the folder as is.

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
show controls instead of playing on their own. For everyone else, **Pause animations** in the header
holds every loop, clip and CSS animation for the visit (WCAG 2.2.2); turning it off again picks
them up where they were. The year, Needs you, webhook, theme and terminal demos also rest after one
round; the sentence demo plays until someone touches it, and the clips loop while on screen.
The tour has a text version under its poster and in its dialog; keep it in step with `demo/film.html`.

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

## The launch film

`demo/launch.html` is a one-minute launch film for social posts, built from the same recordings, with
captions drawn into the picture. It isn't on the page. Render it after `record.mjs`:

```bash
NODE_PATH=$(npm root -g) node site/demo/render-launch.mjs --music Wallpaper.mp3 --out launch.mp4   # --url changes the address on the end card
```

It also writes `launch.srt` and `launch.vtt` with the same captions, and a `launch.jpg` still. The music isn't in the repository:
the film is cut to the first minute of "Wallpaper" by Kevin MacLeod, from incompetech.com, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Wherever the video is posted, credit it as:

> Music: "Wallpaper" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

### LinkedIn cuts

Three 4:5 videos (1080×1350) and a carousel for LinkedIn: `social-aha.html` (asking and approving, 38 s),
`social-reframe.html` (the spreadsheet, then the fix, 26 s) and `social-selfhost.html` (the Docker Compose setup
and the other ways to run it, 47 s). The aha and reframe cuts play clips from `record.mjs`, so run that first;
the self-host cut and the carousel use none. Each video opens on its hook, so the first frame works as the
post's thumbnail. Shared styles and timing live in `demo/social/`.

```bash
for cut in aha reframe selfhost; do
  NODE_PATH=$(npm root -g) node site/demo/render-launch.mjs --music Wallpaper.mp3 --film social-$cut.html --out $cut.mp4 || break
done
NODE_PATH=$(npm root -g) node site/demo/render-carousel.mjs --out carousel.pdf   # also writes one PNG per slide
```

`social-selfhost.html` mirrors the setup in the root README and `docker-compose.yml`; keep them in step.

## Fonts

Instrument Sans and JetBrains Mono, both under the SIL Open Font License 1.1, are served from `fonts/`
so the page makes no third-party requests.
