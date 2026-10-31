# Winterliga Dresden – selbst gehostet

Kleine Web-App für die Bike-Polo-Winterliga: Teams, Begegnungen (Best of 5), Tabelle und Direktvergleich.
Lesen kann jeder mit dem Link, eintragen nur die Orga mit Passwort.

## Inhalt

| Datei | Zweck |
|---|---|
| `server.js` | Node-Server ohne Abhängigkeiten: Seite, API, Passwortprüfung |
| `public/` | Oberfläche (HTML, CSS, JS, Schriften lokal, also keine Google-Fonts-Anfragen) |
| `seed.json` | Startdaten: die bisherigen 4 Teams und 4 Begegnungen |
| `Dockerfile`, `docker-compose.yml` | App-Container plus Tailscale-Sidecar |
| `tailscale/serve.json` | Serve-/Funnel-Konfiguration (HTTPS 443 → App) |

## Einrichten

1. Ordner auf den Homeserver kopieren, z. B.
   `scp -r winterliga-server yaitseric@homelab:~/`
2. Auf dem Server: `cp .env.example .env` und ausfüllen:
   - `TS_AUTHKEY`: neuer Auth-Key aus der Tailscale-Admin-Konsole
   - `TS_EXTRA_ARGS`: Tag mit Funnel-Recht (siehe unten)
   - `ORGA_PASSWORD`: mindestens 8 Zeichen
3. Starten: `docker compose up -d --build`
4. Aufrufen: `https://winterliga.<dein-tailnet>.ts.net`
   Der erste Aufruf kann ein paar Sekunden dauern, bis das Zertifikat da ist.

### Funnel in der ACL

Funnel braucht das Attribut `funnel` für das Gerät. Wenn dein Jellyfin-Sidecar schon über Funnel läuft,
nimm denselben Tag. Sonst in der Policy ergänzen (Tag-Name anpassen):

```json
"tagOwners": { "tag:funnel": ["autogroup:admin"] },
"nodeAttrs": [ { "target": ["tag:funnel"], "attr": ["funnel"] } ]
```

## Betrieb

- **Daten** liegen im Volume `winterliga-data` als `league.json`.
  `seed.json` wird nur beim allerersten Start übernommen, wenn noch keine Daten existieren.
- **Backup:** `docker cp winterliga:/data/league.json ./league-backup.json`
- **Passwort ändern:** in `.env` anpassen, dann `docker compose up -d`.
  Alle Orga-Geräte müssen sich danach neu anmelden.
- **Logs:** `docker compose logs -f winterliga`
- **Update der App:** Dateien ersetzen, dann `docker compose up -d --build`. Die Daten bleiben erhalten.

## Sicherheit

- Die App lauscht nur auf `127.0.0.1` im Netz des Sidecars, es gibt keinen veröffentlichten Host-Port.
- Jede Änderung braucht das Orga-Passwort. Nach 8 Fehlversuchen ist die Anmeldung 10 Minuten gesperrt.
- Strenge Content-Security-Policy, keine externen Skripte oder Schriften.
