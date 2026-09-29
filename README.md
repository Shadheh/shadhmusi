# Shadh Music

A premium minimal claymorphic + liquid-glass YouTube music web app.

## What is included

- YouTube Data API v3 search and discovery
- Official YouTube IFrame Player API playback
- Search filters: relevant, newest, most viewed, top rated
- Queue, shuffle, repeat all / repeat one
- Likes, listening history and local playlists
- Persistent localStorage state
- OLED dark mode + light clay mode
- Sleep timer
- Keyboard shortcuts
- Responsive desktop/tablet/mobile layout
- YouTube thumbnail cards
- API key setup modal with local browser storage
- Demo fallback when no API key is configured

## Run

Serve this folder from a local web server (recommended), e.g. VS Code Live Server.

You can also use any static hosting provider.

## YouTube API setup

1. Create/select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Create an API key.
4. Restrict the key to your site origins and the YouTube Data API.
5. Open the website → **API setup** → paste the key.

The key is stored in this browser's localStorage. For a public production site, a backend proxy is a better approach so the key is not exposed in client-side source.

## Keyboard

Space = play/pause
J = previous
L = next
S = shuffle
R = repeat
/ = focus search
