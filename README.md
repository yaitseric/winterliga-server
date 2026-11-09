# Winterliga – Bike Polo

A small, self-hosted web app for a bike polo winter league: teams, matches (best of 5),
standings, head-to-head records, stats and rules.
Anyone with the link can view it; only the organisers can enter results, using a password.

The app's interface is in German.

## Contents

| File | Purpose |
|---|---|
| `server.js` | Node server with no dependencies: serves the page, the API and checks the password |
| `public/` | Frontend (HTML, CSS, JS; fonts are served locally, so there are no Google Fonts requests) |
| `seed.json` | Initial data, only loaded on the very first start |
| `Dockerfile`, `compose.yaml` | App container plus a Tailscale sidecar |
| `ts-config/winterliga.json` | Serve/Funnel configuration (HTTPS 443 → app) |
| `.env.example` | Template for the environment variables |

## Running locally

Node 22 is all you need, there is nothing to install:

```sh
ORGA_PASSWORD=somelongpassword node server.js
```

The app is then available at `http://localhost:3000`. Data is stored in `./data/league.json`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ORGA_PASSWORD` | – | Required, at least 8 characters |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Address the server listens on |
| `DATA_DIR` | `./data` | Directory for `league.json` |
| `SEED_FILE` | `./seed.json` | Initial data for the first start |

## Running with Docker and Tailscale Funnel

`compose.yaml` starts the app together with a Tailscale sidecar. The app does not publish any port;
it is only reachable through Tailscale Serve/Funnel at `https://winterliga.<your-tailnet>.ts.net`.

1. `cp .env.example .env` and fill it in (`TS_AUTHKEY`, `ORGA_PASSWORD`).
2. Funnel has to be allowed for the device, e.g. via a tag in your Tailscale policy:
   ```json
   "tagOwners": { "tag:funnel": ["autogroup:admin"] },
   "nodeAttrs": [ { "target": ["tag:funnel"], "attr": ["funnel"] } ]
   ```
   Then create the auth key with that tag.
3. Start it: `docker compose up -d --build`
   The first request can take a few seconds until the certificate has been issued.

If you don't use Tailscale, you can put the container behind a different reverse proxy instead.
That proxy should run on the same machine and set `X-Forwarded-For`, see the Security section.

### Day-to-day operation

- **Data** is stored in the volume as `league.json`.
- **Backup:** `docker cp winterliga:/data/league.json ./league-backup.json`
- **Change the password:** edit `.env`, then run `docker compose up -d`.
  All organiser devices have to log in again afterwards.
- **Logs:** `docker compose logs -f winterliga`
- **Update:** replace the files, then run `docker compose up -d --build`. Your data is kept.

## Security

- Every change requires the organiser password. After 8 failed attempts, login is blocked
  for that IP for 10 minutes.
- `X-Forwarded-For` is only trusted when the request comes from `localhost` (i.e. the local
  proxy), and then only its last entry. Clients connecting directly cannot spoof their IP this way.
- In the Docker setup, the app only listens on `127.0.0.1` inside the sidecar's network.
- The container runs read-only, without capabilities and as an unprivileged user.
- Strict Content Security Policy, no external scripts or fonts.
