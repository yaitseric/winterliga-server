// Winterliga Bike Polo Dresden – kleiner Server ohne externe Abhängigkeiten.
// Liefert die Seite aus, speichert Teams und Begegnungen in einer JSON-Datei
// und erlaubt Änderungen nur mit dem Orga-Passwort (ORGA_PASSWORD).
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "league.json");
const SEED_FILE = process.env.SEED_FILE || path.join(__dirname, "seed.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const PASSWORD = process.env.ORGA_PASSWORD || "";
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 3;

if (PASSWORD.length < 8) {
  console.error("ORGA_PASSWORD fehlt oder ist kürzer als 8 Zeichen. Setze es in der .env-Datei.");
  process.exit(1);
}
const PASSWORD_HASH = crypto.createHash("sha256").update(PASSWORD).digest();

// ---------- Speicher ----------
function emptyState() { return { rev: 1, teams: [], series: [] }; }

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    let initial = emptyState();
    if (fs.existsSync(SEED_FILE)) {
      initial = { ...emptyState(), ...JSON.parse(fs.readFileSync(SEED_FILE, "utf8")) };
      console.log(`Startdaten aus ${path.basename(SEED_FILE)} übernommen: ${initial.teams.length} Teams, ${initial.series.length} Begegnungen.`);
    }
    writeState(initial);
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeState(s) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Begegnungen aus der Zeit vor den 3er-Teams bekommen ihre Aufstellung nachträglich,
// damit ein später dazukommender dritter Spieler dort nicht auftaucht.
function addMissingLineups(s) {
  const playersOf = (id) => [...((s.teams.find((t) => t.id === id) || {}).players || [])];
  const missing = s.series.filter((m) => !m.lineupA || !m.lineupB);
  missing.forEach((m) => { m.lineupA = m.lineupA || playersOf(m.a); m.lineupB = m.lineupB || playersOf(m.b); });
  return missing.length > 0;
}

let state = loadState();
function commit() { state.rev = (state.rev || 0) + 1; writeState(state); }
if (addMissingLineups(state)) commit();

// ---------- Validierung ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const newId = () => crypto.randomBytes(10).toString("hex");
const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");

function checkName(name, selfId) {
  const n = clean(name);
  if (!n) throw bad("Gib einen Teamnamen ein.");
  if (n.length > 40) throw bad("Der Teamname darf höchstens 40 Zeichen haben.");
  if (state.teams.some((t) => t.id !== selfId && t.name.toLowerCase() === n.toLowerCase())) throw bad(`„${n}“ gibt es schon.`);
  return n;
}
const TOO_FEW_PLAYERS = `Ein Team braucht mindestens ${MIN_PLAYERS} Spieler.`;
function checkPlayers(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw bad("Spieler müssen als Liste kommen.");
  const out = [];
  for (const p of list) {
    const n = clean(p);
    if (!n) continue;
    if (n.length > 40) throw bad("Ein Spielername darf höchstens 40 Zeichen haben.");
    if (out.some((q) => q.toLowerCase() === n.toLowerCase())) throw bad(`„${n}“ ist schon im Team.`);
    out.push(n);
  }
  if (out.length > MAX_PLAYERS) throw bad(`Ein Team hat höchstens ${MAX_PLAYERS} Spieler.`);
  return out;
}
// In einer Begegnung spielen 2 Leute: Ein Team mit mehr Spielern muss sie auswählen, die Auswahl bleibt danach fest.
function checkLineup(team, chosen) {
  if (team.players.length <= 2) return [...team.players];
  const picked = Array.isArray(chosen) ? team.players.filter((p) => chosen.includes(p)) : [];
  if (picked.length !== 2) throw bad(`Wähle für „${team.name}“ genau 2 Spieler aus.`);
  return picked;
}
function checkDate(d) {
  if (d == null || d === "") return null;
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw bad("Das Datum ist ungültig.");
  return d;
}
function checkGames(games) {
  if (!Array.isArray(games)) throw bad("Spiele müssen als Liste kommen.");
  if (games.length > 5) throw bad("Eine Begegnung hat höchstens 5 Spiele.");
  return games.map((g) => {
    const a = Number(g && g.a), b = Number(g && g.b);
    if (![a, b].every((x) => Number.isInteger(x) && x >= 0 && x <= 99)) throw bad("Tore müssen ganze Zahlen von 0 bis 99 sein.");
    return { a, b };
  });
}
const findTeam = (id) => state.teams.find((t) => t.id === id) || (() => { throw new HttpError(404, "Team nicht gefunden."); })();
const findSeries = (id) => state.series.find((s) => s.id === id) || (() => { throw new HttpError(404, "Begegnung nicht gefunden."); })();

// ---------- Anmeldung mit Bremse gegen Raten ----------
const fails = new Map(); // ip -> { n, until }
// X-Forwarded-For kann jeder Client selbst mitschicken. Der Header zählt deshalb nur, wenn
// die Anfrage vom lokalen Proxy kommt (Tailscale Serve/Funnel im selben Netz), und dann nur
// sein letzter Eintrag: den hat der Proxy gesetzt, alles davor könnte gefälscht sein.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function clientIp(req) {
  const peer = req.socket.remoteAddress || "?";
  if (!LOOPBACK.has(peer)) return peer;
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
  return fwd || peer;
}
function checkAuth(req) {
  const ip = clientIp(req), now = Date.now();
  const f = fails.get(ip);
  if (f && f.until > now) throw new HttpError(429, "Zu viele Fehlversuche. Versuch es in ein paar Minuten noch einmal.");
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
  const given = crypto.createHash("sha256").update(m ? m[1] : "").digest();
  if (!m || !crypto.timingSafeEqual(given, PASSWORD_HASH)) {
    const rec = f && now - f.last < 15 * 60e3 ? f : { n: 0, until: 0, last: 0 };
    rec.n += 1;
    rec.last = now;
    if (rec.n >= 8) { rec.until = now + 10 * 60e3; rec.n = 0; }
    fails.set(ip, rec);
    throw new HttpError(401, "Das Orga-Passwort stimmt nicht.");
  }
  fails.delete(ip);
}

// ---------- HTTP ----------
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".avif": "image/avif", ".webp": "image/webp",".txt": "text/plain; charset=utf-8" };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 32 * 1024) { reject(new HttpError(413, "Anfrage zu groß.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {}); }
      catch { reject(bad("Ungültiges JSON.")); }
    });
    req.on("error", reject);
  });
}
const publicState = () => ({ rev: state.rev, teams: state.teams, series: state.series });

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, "Nicht gefunden");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Nicht gefunden", { "Content-Type": "text/plain; charset=utf-8" });
    const ext = path.extname(file);
    const cache = ext === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": cache, "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function api(req, res, parts) {
  const [, resource, id] = parts; // ["api", resource, id]
  const method = req.method;

  if (resource === "state" && method === "GET") {
    const etag = `"${state.rev}"`;
    if (req.headers["if-none-match"] === etag) return send(res, 304, "", { ETag: etag, "Cache-Control": "no-cache" });
    return send(res, 200, JSON.stringify(publicState()), { "Content-Type": "application/json; charset=utf-8", ETag: etag, "Cache-Control": "no-cache" });
  }
  if (resource === "login" && method === "POST") { checkAuth(req); return sendJson(res, 200, { ok: true }); }

  if (!["POST", "PATCH", "DELETE"].includes(method)) throw new HttpError(405, "Methode nicht erlaubt.");
  checkAuth(req);
  const body = method === "DELETE" ? {} : await readBody(req);
  let createdId = null;

  if (resource === "teams") {
    if (method === "POST" && !id) {
      const players = checkPlayers(body.players);
      if (players.length < MIN_PLAYERS) throw bad(TOO_FEW_PLAYERS);
      const team = { id: newId(), name: checkName(body.name), players, createdAt: Date.now() };
      state.teams.push(team); createdId = team.id;
    } else if (method === "PATCH" && id) {
      const t = findTeam(id);
      const name = "name" in body ? checkName(body.name, id) : t.name;
      const players = "players" in body ? checkPlayers(body.players) : t.players;
      // Kein Team darf unter das Minimum schrumpfen. Ältere Teams mit zu wenigen Spielern lassen sich aber einzeln auffüllen.
      if (players.length < MIN_PLAYERS && players.length < t.players.length) throw bad(TOO_FEW_PLAYERS);
      t.name = name; t.players = players;
    } else if (method === "DELETE" && id) {
      findTeam(id);
      if (state.series.some((s) => s.a === id || s.b === id)) throw new HttpError(409, "Das Team hat noch Begegnungen. Lösche zuerst die Begegnungen.");
      state.teams = state.teams.filter((t) => t.id !== id);
    } else throw new HttpError(404, "Unbekannte Anfrage.");
  } else if (resource === "series") {
    if (method === "POST" && !id) {
      const a = String(body.a || ""), b = String(body.b || "");
      const teamA = findTeam(a), teamB = findTeam(b);
      if (a === b) throw bad("Ein Team kann nicht gegen sich selbst spielen.");
      const s = { id: newId(), a, b, lineupA: checkLineup(teamA, body.lineupA), lineupB: checkLineup(teamB, body.lineupB), date: checkDate(body.date), games: [], createdAt: Date.now() };
      state.series.push(s); createdId = s.id;
    } else if (method === "PATCH" && id) {
      const s = findSeries(id);
      const games = "games" in body ? checkGames(body.games) : s.games;
      const date = "date" in body ? checkDate(body.date) : s.date;
      s.games = games; s.date = date;
    } else if (method === "DELETE" && id) {
      findSeries(id);
      state.series = state.series.filter((s) => s.id !== id);
    } else throw new HttpError(404, "Unbekannte Anfrage.");
  } else throw new HttpError(404, "Unbekannte Anfrage.");

  commit();
  sendJson(res, 200, { state: publicState(), id: createdId });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const urlPath = decodeURIComponent(url.pathname);
    if (urlPath === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
    const parts = urlPath.split("/").filter(Boolean);
    if (parts[0] === "api") return await api(req, res, parts);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Methode nicht erlaubt");
    return serveStatic(req, res, urlPath);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    return sendJson(res, 500, { error: "Interner Fehler. Bitte später noch einmal versuchen." });
  }
});

server.listen(PORT, HOST, () => console.log(`Winterliga läuft auf http://${HOST}:${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
