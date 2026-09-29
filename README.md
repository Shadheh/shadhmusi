# Shadh Music

A premium claymorphic / liquid-glass YouTube music web app.

## Features

- YouTube Data API v3 search with relevance, newest, most-viewed and top-rated ordering.
- Official YouTube IFrame Player API playback.
- Smart recommendations based on the current search, current track, likes and listening history.
- Smart Radio that fills the queue with recommendation results.
- Mood discovery shortcuts (Chill, Focus, Workout, Malayalam, Lo-fi, Night drive, etc.).
- Queue with next/previous, shuffle, repeat-off/all/one, clear and drag-to-reorder.
- Local liked tracks, listening history and unlimited local playlists.
- Playlist create, rename, delete and remove-track actions.
- Sleep timer.
- Search history suggestions.
- Keyboard shortcuts: Space play/pause, J/K previous/next, M mute, S shuffle, R repeat, Q now playing, ←/→ seek, / focus search.
- Browser Media Session integration where supported.
- Export/import JSON backup for queue, likes, history, playlists and current track.
- OLED dark theme and light clay theme.
- Responsive desktop, tablet and mobile layout.
- Graceful API errors and a demo player fallback path.
- Local-first storage; no account system required.

## YouTube API setup

The included `config.js` is prefilled with the YouTube Data API v3 key supplied for this build. The app automatically uses it when no browser-saved key exists.

For safety, restrict that key in Google Cloud to **YouTube Data API v3** and the exact origins you will use (for example your production site and localhost during development). Because browser code can expose client-side keys, rotate the key before publishing this project publicly if you do not want the currently supplied key to remain associated with this build.

1. Create or select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Create an API key.
4. Restrict the key to your web origin and to the YouTube Data API where practical.
5. Open **Connect YouTube** in Shadh Music and save the key.

The app uses `search.list` for public video discovery and `videoEmbeddable=true` / `videoSyndicated=true` so search results are more suitable for embedded playback. Playback controls use the official YouTube IFrame API.

For a public production deployment, prefer a server-side proxy or serverless endpoint so the browser does not carry the API key directly. For a personal/local build, the built-in browser-key flow is convenient.

## Run locally

Serve the folder with any static web server, then open `index.html` through `http://localhost/...` rather than relying on a `file://` URL.

Example:

```bash
python -m http.server 8000
```

Then open:

`http://localhost:8000/shadh-music/`

## Notes

The website is intentionally local-first. Search and recommendation requests go to Google's YouTube API only when a key is configured. YouTube playback is handled by the official embedded player.
