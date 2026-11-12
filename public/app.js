"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 3;
  const VIEWS = ["tabelle", "begegnungen", "teams", "stats", "live"];
  const FACTS_SHOWN = 4;
  const S = {
    teams: [], series: [], tLoaded: false, sLoaded: false,
    canWrite: false, key: null, etag: null, offline: false,
    open: new Set(), editTeam: null, confirm: null, busy: new Set(), msg: {},
    pick: { a: [], b: [] }, pickHtml: { a: "", b: "" },
    view: VIEWS[0], rules: false, scrollTo: null, factIds: [], chart: null, chartW: 0, chartMetric: "points", eloK: 64, elo: null,
  };

  // ---------- Server ----------
  const KEY_STORE = "winterliga-orga";
  try { S.key = localStorage.getItem(KEY_STORE); S.canWrite = !!S.key; } catch (_) { }
  function setKey(k) {
    S.key = k; S.canWrite = !!k;
    try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch (_) { }
  }
  function applyState(st) {
    S.teams = (st.teams || []).map((t) => ({ id: t.id, name: String(t.name || "Team"), players: Array.isArray(t.players) ? t.players : [] }));
    S.series = (st.series || []).map((s) => ({ id: s.id, a: s.a, b: s.b, lineupA: Array.isArray(s.lineupA) ? s.lineupA : [], lineupB: Array.isArray(s.lineupB) ? s.lineupB : [], date: s.date || null, createdAt: s.createdAt || 0, games: Array.isArray(s.games) ? s.games : [] }));
    S.tLoaded = S.sLoaded = true;
    // Muss zum ETag des Servers passen, der K gehört mit hinein.
    S.etag = `"${st.rev}-${st.eloK}"`;
    S.eloK = Number(st.eloK) || S.eloK;
    S.elo = null;
  }
  async function api(method, url, body) {
    const headers = { "Content-Type": "application/json" };
    if (S.key) headers.Authorization = "Bearer " + S.key;
    let res;
    try { res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch (_) { throw { message: "Keine Verbindung zum Server. Prüfe dein Netz und versuch es noch einmal." }; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== "/api/login") { setKey(null); render(); throw { message: "Du bist nicht mehr als Orga angemeldet. Melde dich neu an." }; }
    if (!res.ok) throw { message: data.error || "Speichern hat nicht geklappt. Versuch es noch einmal." };
    if (data.state) { applyState(data.state); render(); }
    return data;
  }
  async function refresh() {
    try {
      const res = await fetch("/api/state", { headers: S.etag ? { "If-None-Match": S.etag } : {} });
      if (res.status === 304) { if (S.offline) { S.offline = false; render(); } return; }
      if (!res.ok) throw new Error(String(res.status));
      applyState(await res.json());
      S.offline = false;
    } catch (_) { S.offline = true; }
    render();
  }

  // ---------- derived data ----------
  const playersOf = (id) => (S.teams.find((t) => t.id === id) || {}).players || [];
  const teamName = (id) => (S.teams.find((t) => t.id === id) || {}).name || "Gelöschtes Team";
  // Kürzel für die Spaltenköpfe im Direktvergleich: Anfangsbuchstaben, bei einem Wort die ersten zwei Zeichen.
  function initials(name) {
    const words = name.trim().split(/\s+/).map((w) => Array.from(w));
    return (words.length > 1 ? words.map((w) => w[0]).slice(0, 3) : words[0].slice(0, 2)).join("").toUpperCase();
  }
  // Wer in der Begegnung spielt. Hatte das Team beim Anlegen noch keine 2 Spieler, gilt sein aktueller Stand.
  function lineupOf(s, side) {
    const lineup = side === "a" ? s.lineupA : s.lineupB;
    return lineup.length >= 2 ? lineup : playersOf(s[side]);
  }
  function stats(s) {
    let wa = 0, wb = 0, d = 0, ga = 0, gb = 0;
    const games = s.games || [];
    games.forEach((g) => { ga += g.a; gb += g.b; if (g.a > g.b) wa++; else if (g.b > g.a) wb++; else d++; });
    const n = games.length, rest = Math.max(0, 5 - n);
    // Entschieden, sobald der Rückstand in den restlichen Spielen nicht mehr aufzuholen ist, spätestens nach 5 Spielen.
    const done = n >= 5 || wa > wb + rest || wb > wa + rest;
    const winner = done ? (wa > wb ? "a" : wb > wa ? "b" : null) : null;
    // Spielstand der Begegnung: Sieg 1, unentschiedenes Spiel je 0.5. Die halben Punkte heben sich auf, ändern also weder done noch winner.
    const pa = wa + d / 2, pb = wb + d / 2;
    return { wa, wb, d, pa, pb, ga, gb, n, done, winner, draw: done && !winner, state: done ? "done" : n ? "live" : "open" };
  }

  // ---------- Elo ----------
  // Alle Teams starten bei 1000, entschiedene Begegnungen zählen in der Reihenfolge der Spieltage
  // (Sieg 1, Unentschieden 0,5, Niederlage 0). Die gerundete Änderung bekommt ein Team gutgeschrieben
  // und das andere abgezogen, so bleibt die Summe aller Ratings gleich.
  const expectedScore = (r1, r2) => 1 / (1 + 10 ** ((r2 - r1) / 400));
  // Einmal je Stand berechnet, applyState verwirft das Ergebnis.
  function eloRatings() {
    if (S.elo) return S.elo;
    const ratings = new Map(S.teams.map((t) => [t.id, 1000]));
    const steps = [{ series: null, vals: new Map(ratings) }];
    S.series.filter((s) => ratings.has(s.a) && ratings.has(s.b)).sort(byOldest).forEach((s) => {
      const st = stats(s);
      if (!st.done) return;
      const ra = ratings.get(s.a), rb = ratings.get(s.b);
      const d = Math.round(S.eloK * ((st.winner === "a" ? 1 : st.winner === "b" ? 0 : 0.5) - expectedScore(ra, rb)));
      ratings.set(s.a, ra + d); ratings.set(s.b, rb - d);
      steps.push({ series: s, vals: new Map(ratings) });
    });
    return (S.elo = { ratings, steps });
  }

  // Erste Begegnung je Paarung (nach Datum, dann Anlagezeitpunkt) bringt beiden Teams +1.
  function firstMeetings() {
    const first = new Map();
    const key = (s) => [s.a, s.b].sort().join("|");
    const when = (s) => [s.date || "9999-12-31", s.createdAt || 0];
    S.series.forEach((s) => {
      const k = key(s), cur = first.get(k);
      if (!cur) { first.set(k, s); return; }
      const [d1, c1] = when(s), [d2, c2] = when(cur);
      if (d1 < d2 || (d1 === d2 && c1 < c2)) first.set(k, s);
    });
    return new Set([...first.values()].map((s) => s.id));
  }
  // Liga-Punkte einer entschiedenen Begegnung; Tabelle und Punkteverlauf rechnen beide hiermit.
  function leaguePoints(s, st, firsts) {
    const bonus = firsts.has(s.id) ? 1 : 0, base = (side) => (!st.winner ? 1 : st.winner === side ? 2 : 0);
    return { a: base("a") + bonus, b: base("b") + bonus };
  }
  function standings() {
    const firsts = firstMeetings();
    const rows = new Map(S.teams.map((t) => [t.id, { id: t.id, name: t.name, pts: 0, bonus: 0, sp: 0, sw: 0, sd: 0, sl: 0, gw: 0, gd: 0, gl: 0, gf: 0, gag: 0 }]));
    S.series.forEach((s) => {
      const st = stats(s), A = rows.get(s.a), B = rows.get(s.b);
      if (!A || !B || !st.n) return;
      A.sp++; B.sp++;
      A.gw += st.wa; A.gl += st.wb; B.gw += st.wb; B.gl += st.wa; A.gd += st.d; B.gd += st.d;
      A.gf += st.ga; A.gag += st.gb; B.gf += st.gb; B.gag += st.ga;
      if (st.done) {
        const p = leaguePoints(s, st, firsts);
        A.pts += p.a; B.pts += p.b;
        if (st.winner === "a") { A.sw++; B.sl++; } else if (st.winner === "b") { B.sw++; A.sl++; } else { A.sd++; B.sd++; }
        if (firsts.has(s.id)) { A.bonus++; B.bonus++; }
      }
    });
    return [...rows.values()].sort((x, y) =>
      y.pts - x.pts || y.sw - x.sw || y.sd - x.sd || x.sl - y.sl || (y.gw - y.gl) - (x.gw - x.gl) || (y.gf - y.gag) - (x.gf - x.gag) || x.name.localeCompare(y.name, "de"));
  }

  // ---------- render ----------
  function snapshotInputs() {
    const keep = {}; let focus = null;
    document.querySelectorAll("#app input[id], #app select[id]").forEach((el) => { keep[el.id] = el.value; });
    if (document.activeElement && document.activeElement.id) {
      const el = document.activeElement;
      focus = { id: el.id, s: el.selectionStart, e: el.selectionEnd };
    }
    return { keep, focus };
  }
  function restoreInputs({ keep, focus }) {
    Object.entries(keep).forEach(([id, v]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.tagName === "SELECT") { if ([...el.options].some((o) => o.value === v)) el.value = v; }
      else el.value = v;
    });
    if (focus) {
      const el = document.getElementById(focus.id);
      if (el) { el.focus(); try { if (focus.s != null) el.setSelectionRange(focus.s, focus.e); } catch (_) { } }
    }
  }

  function render() {
    const saved = snapshotInputs();
    const loaded = S.tLoaded && S.sLoaded;

    // banner
    const banner = $("#banner");
    if (S.offline) { banner.hidden = false; banner.textContent = loaded ? "Der Server ist gerade nicht erreichbar. Die angezeigten Stände sind vielleicht nicht aktuell." : "Der Server ist gerade nicht erreichbar. Die Seite versucht es weiter."; }
    else banner.hidden = true;
    $("#orga-off").hidden = S.canWrite; $("#orga-on").hidden = !S.canWrite;
    if (S.canWrite) $("#login-form").hidden = true;

    $("#team-form").hidden = !(loaded && S.canWrite);
    $("#series-form").hidden = !(loaded && S.canWrite && S.teams.length >= 2);

    // summary
    const all = S.series.map(stats);
    const games = all.reduce((n, s) => n + s.n, 0);
    const live = all.filter((s) => s.state === "live").length;
    const done = all.filter((s) => s.state === "done").length;
    $("#summary").innerHTML = loaded
      ? `<span><b>${S.teams.length}</b> Teams</span><span><b>${S.series.length}</b> Begegnungen</span><span><b>${done}</b> entschieden</span><span><b>${live}</b> laufend</span><span><b>${games}</b> Spiele gespielt</span>`
      : "Lade Spielstände …";
    $("#series-count").textContent = loaded && S.series.length ? `${done} / ${S.series.length} entschieden` : "";
    $("#team-count").textContent = loaded ? `${S.teams.length}` : "";

    // series selects
    const opts = '<option value="">Team wählen</option>' + [...S.teams].sort((a, b) => a.name.localeCompare(b.name, "de")).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    $("#series-a").innerHTML = opts; $("#series-b").innerHTML = opts;

    renderLive(loaded);
    renderRecent(loaded);
    renderFacts(loaded);
    renderChart();
    renderSeries(loaded);
    renderStandings(loaded);
    renderMatrix(loaded);
    renderTeams(loaded);
    restoreInputs(saved);
    renderLineupPick();
  }

  // Hat ein Team mehr als 2 Spieler, muss beim Anlegen der Begegnung feststehen, welche 2 spielen.
  // Nur bei Änderungen neu zeichnen, damit die 15-Sekunden-Aktualisierung den Fokus nicht wegnimmt.
  function renderLineupPick() {
    ["a", "b"].forEach((side) => {
      const box = $(`#lineup-${side}`), id = $(`#series-${side}`).value, players = playersOf(id);
      const pick = S.pick[side] = S.pick[side].filter((p) => players.includes(p));
      const options = players.map((p, i) => {
        const on = pick.includes(p), full = !on && pick.length >= 2;
        return `<label class="pick"><input type="checkbox" id="pick-${side}-${i}" value="${esc(p)}" data-act="pick" data-side="${side}" ${on ? "checked" : ""} ${full ? "disabled" : ""}>${esc(p)}</label>`;
      }).join("");
      const html = players.length > 2 ? `<fieldset><legend>Wer spielt für ${esc(teamName(id))}? 2 von ${players.length} auswählen</legend>${options}</fieldset>` : "";
      if (html === S.pickHtml[side]) return;
      S.pickHtml[side] = html; box.innerHTML = html; box.hidden = !html;
    });
  }

  function emptyBox(title, text) { return `<div class="empty"><strong>${title}</strong><p>${text}</p></div>`; }

  function renderSeries(loaded) {
    const box = $("#series");
    if (!loaded) { box.innerHTML = `<div class="panel">${emptyBox("Lade Begegnungen", "Einen Moment.")}</div>`; return; }
    if (!S.series.length) {
      box.innerHTML = `<div class="panel">${emptyBox("Noch keine Begegnungen",
        S.teams.length < 2
          ? "Lege zuerst mindestens zwei Teams an (im Bereich Teams). Danach kannst du hier Paarungen anlegen und jedes Spiel der Begegnung (Best of 5) eintragen."
          : "Wähle oben zwei Teams und lege die erste Begegnung an. Jede Begegnung geht über maximal fünf Spiele. Sie ist entschieden, sobald ein Team nicht mehr eingeholt werden kann, und kann auch als Draw enden.")}</div>`;
      return;
    }
    const list = [...S.series].sort(byNewest);
    const firsts = firstMeetings();
    box.innerHTML = [["live", "Läuft"], ["open", "Angesetzt"], ["done", "Entschieden"]].map(([state, title]) => {
      const cards = list.filter((s) => stats(s).state === state);
      return cards.length ? `<div class="series-group"><h3>${title} <small>${cards.length}</small></h3><div class="series-grid">${cards.map((s) => seriesCard(s, firsts)).join("")}</div></div>` : "";
    }).join("");
  }

  // Laufende Begegnungen direkt auf der Startseite; ein Klick öffnet die Karte im Bereich Begegnungen.
  function renderLive(loaded) {
    const live = loaded ? S.series.filter((s) => stats(s).state === "live") : [];
    $("#live-box").hidden = !live.length;
    $("#live").innerHTML = live.map((s) => {
      const st = stats(s);
      return `<a class="live-row panel" href="#begegnungen" data-act="openseries" data-id="${esc(s.id)}">
        <span class="tname ta">${esc(teamName(s.a))}</span>
        <span class="sscore"><span class="ca">${st.pa}</span><span class="x">:</span><span class="cb">${st.pb}</span></span>
        <span class="tname tb">${esc(teamName(s.b))}</span>
        <span class="meta">${pipsOf(s, st)}<span>${st.n}/5 Spiele</span></span>
      </a>`;
    }).join("");
  }

  function renderRecent(loaded) {
    const done = loaded ? S.series.filter((s) => stats(s).done).sort(byNewest).slice(0, 3) : [];
    $("#recent-box").hidden = !done.length;
    $("#recent").innerHTML = done.map((s) => {
      const st = stats(s);
      return `<a class="result" href="#begegnungen" data-act="openseries" data-id="${esc(s.id)}">
        <span class="rdate">${s.date ? fmtDate(s.date).slice(0, 6) : ""}</span>
        <span class="rteam ta${st.winner === "a" ? " won" : ""}">${esc(teamName(s.a))}</span>
        <span class="rscore"><span class="ca">${st.pa}</span> : <span class="cb">${st.pb}</span></span>
        <span class="rteam tb${st.winner === "b" ? " won" : ""}">${esc(teamName(s.b))}</span>
      </a>`;
    }).join("");
  }

  // Alle Kennzahlen der Saison. Ein Wert von 0 bleibt in der Übersicht, kommt aber nicht auf die Startseite.
  function seasonStats() {
    const played = S.series.filter((s) => s.games.length);
    const games = played.flatMap((s) => s.games.map((g) => ({ ...g, s })));
    if (!games.length) return [];
    const done = played.filter((s) => stats(s).done);
    const goals = games.reduce((n, g) => n + g.a + g.b, 0);
    const inGames = `in ${games.length} ${games.length === 1 ? "Spiel" : "Spielen"}`;
    const allPairs = S.teams.length * (S.teams.length - 1) / 2;
    const playedPairs = new Set(played.map((s) => [s.a, s.b].sort().join("|"))).size;
    const wild = games.reduce((most, g) => (g.a + g.b > most.a + most.b ? g : most));
    const comebacks = done.filter((s) => {
      const first = s.games[0], { winner } = stats(s);
      return (winner === "a" && first.a < first.b) || (winner === "b" && first.b < first.a);
    }).length;

    const table = standings();
    const mostGoals = Math.max(...table.map((r) => r.gf));
    const scorers = table.filter((r) => r.gf === mostGoals).map((r) => esc(r.name)).join(", ");

    return [
      { id: "goals", value: goals, label: "Tore", sub: inGames },
      { id: "perGame", value: (goals / games.length).toFixed(1), label: "Tore pro Spiel" },
      { id: "draws", value: games.filter((g) => g.a === g.b).length, label: "Draws", sub: inGames },
      { id: "pairs", value: `${playedPairs} / ${allPairs}`, label: "Paarungen", sub: "haben schon gespielt" },
      { id: "close", value: games.filter((g) => Math.abs(g.a - g.b) === 1).length, label: "Knappe Spiele", sub: "mit 1 Tor Unterschied" },
      { id: "shutouts", value: games.filter((g) => g.a !== g.b && Math.min(g.a, g.b) === 0).length, label: "Zu null", sub: "Spiele ohne Gegentor" },
      { id: "wild", value: wild.a + wild.b, label: "Tore in einem Spiel", sub: `${wild.a} : ${wild.b}, ${esc(teamName(wild.s.a))} gegen ${esc(teamName(wild.s.b))}` },
      { id: "topGoals", value: mostGoals, label: "Meiste Tore", sub: scorers },
      { id: "perSeries", value: done.length ? (done.reduce((n, s) => n + s.games.length, 0) / done.length).toFixed(1) : 0, label: "Spiele pro Begegnung", sub: "im Schnitt" },
      { id: "days", value: new Set(played.map(dayOf)).size, label: "Spieltage", sub: "bisher" },
      { id: "people", value: new Set(played.flatMap((s) => [...lineupOf(s, "a"), ...lineupOf(s, "b")])).size, label: "Spieler", sub: "waren schon dabei" },
      { id: "comebacks", value: comebacks, label: "Comebacks", sub: "Win nach verlorenem ersten Spiel" },
    ];
  }

  const statTile = (f) => `<div class="tile panel" data-stat="${f.id}"><b>${f.value}</b><span>${f.label}</span>${f.sub ? `<small>${f.sub}</small>` : ""}</div>`;

  // Zufällige Auswahl für die Startseite; was gerade zu sehen ist, kommt beim Neu-Würfeln zuletzt dran.
  function pickFacts(avoid = []) {
    const pool = seasonStats().filter((f) => f.value !== 0).map((f) => f.id);
    const mix = (ids) => ids.map((id) => [Math.random(), id]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);
    return [...mix(pool.filter((id) => !avoid.includes(id))), ...mix(avoid.filter((id) => pool.includes(id)))].slice(0, FACTS_SHOWN);
  }

  function renderFacts(loaded) {
    const all = loaded ? seasonStats() : [], pool = all.filter((f) => f.value !== 0);
    $("#facts-box").hidden = !all.length;
    $("#all-stats").innerHTML = all.length ? all.map(statTile).join("") : `<div class="panel stats-empty">${emptyBox("Noch keine Zahlen", "Sobald das erste Spiel eingetragen ist, stehen hier die Zahlen der Saison.")}</div>`;
    if (!all.length) return;
    // Die Auswahl bleibt bei jeder Aktualisierung stehen, nur der Knopf würfelt neu.
    const stale = S.factIds.length !== Math.min(FACTS_SHOWN, pool.length) || !S.factIds.every((id) => pool.some((f) => f.id === id));
    if (stale) S.factIds = pickFacts();
    $("#facts").innerHTML = S.factIds.map((id) => statTile(pool.find((f) => f.id === id))).join("");
    $("#facts-shuffle").hidden = pool.length <= FACTS_SHOWN;
  }

  // Stand aller Teams nach jedem Schritt, beginnend bei 0. Punkte gibt es erst für entschiedene Begegnungen,
  // Tore zählen wie in der Tabelle auch aus laufenden. Das Rating hat eine eigene Rechnung und startet bei 1000.
  function chartHistory(metric) {
    if (metric === "rating") return eloRatings().steps;
    const firsts = firstMeetings(), goals = metric === "goals";
    const totals = new Map(S.teams.map((t) => [t.id, 0]));
    const steps = [{ series: null, vals: new Map(totals) }];
    S.series.filter((s) => (goals ? s.games.length : stats(s).done) && totals.has(s.a) && totals.has(s.b)).sort(byOldest).forEach((s) => {
      const st = stats(s), add = goals ? { a: st.ga, b: st.gb } : leaguePoints(s, st, firsts);
      totals.set(s.a, totals.get(s.a) + add.a); totals.set(s.b, totals.get(s.b) + add.b);
      steps.push({ series: s, vals: new Map(totals) });
    });
    return steps;
  }

  // Die Farbe gehört zum Team (Anlage-Reihenfolge), nicht zum Tabellenplatz, und bleibt so über die Saison gleich.
  const teamColor = (i) => (i < 8 ? `var(--team-${i + 1})` : "var(--muted)");

  function renderChart() {
    const box = $("#chart"), W = box.clientWidth, goals = S.chartMetric === "goals", rating = S.chartMetric === "rating";
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.metric === S.chartMetric)));
    $("#chart-note").textContent = rating
      ? "Jeder Schritt zeigt das Rating nach einer entschiedenen Begegnung, in der Reihenfolge der Spieltage. Alle Teams starten bei 1000."
      : `Jeder Schritt ist eine ${goals ? "Begegnung mit eingetragenen Spielen, auch wenn sie noch läuft" : "entschiedene Begegnung"}, in der Reihenfolge der Spieltage. Ohne Datum zählt der Tag, an dem sie angelegt wurde.`;
    S.chartW = W;
    if (!W) return;
    const openStep = S.chart ? S.chart.i : null;
    const steps = chartHistory(S.chartMetric), n = steps.length - 1;
    if (!n) {
      S.chart = null;
      $("#chart-tip").hidden = true;
      box.innerHTML = emptyBox("Noch kein Verlauf", goals ? "Sobald das erste Spiel eingetragen ist, entsteht hier die Kurve." : "Sobald die erste Begegnung entschieden ist, entsteht hier die Kurve.");
      $("#chart-legend").innerHTML = ""; $("#chart-table").innerHTML = "";
      return;
    }
    const last = steps[n].vals, H = W < 600 ? 230 : 280, top = 12, bottom = 24;
    // Punkte und Tore beginnen bei 0, das Rating wird um seinen tatsächlichen Bereich herum skaliert.
    let yMin = 0, yMax, tick;
    if (rating) {
      const values = steps.flatMap((st) => [...st.vals.values()]);
      const min = Math.min(...values), max = Math.max(...values);
      tick = [1, 2, 5, 10, 20, 50, 100, 200].find((t) => (max - min) / t <= 5) || 500;
      yMin = Math.floor(min / tick) * tick; yMax = Math.ceil(max / tick) * tick;
      // Auch bei lauter gleichen Ratings einen sichtbaren Bereich zeigen.
      if (yMin === yMax) { yMin -= tick; yMax += tick; }
    } else {
      const max = Math.max(1, ...last.values());
      tick = [1, 2, 5, 10, 20, 50, 100].find((t) => max / t <= 5) || 200;
      yMax = Math.ceil(max / tick) * tick;
    }
    const y = (v) => top + (H - top - bottom) * (1 - (v - yMin) / (yMax - yMin));
    // Links Platz für die längste Achsenbeschriftung (vierstellige Ratings), mindestens die bisherigen 26px.
    const gridValues = Array.from({ length: (yMax - yMin) / tick + 1 }, (_, i) => yMin + i * tick);
    const left = Math.max(26, Math.max(...gridValues.map((v) => String(v).length)) * 6.8 + 12);

    // Endbeschriftung nur mit Namen, die Werte stehen im Graph und im Tooltip.
    // Teams auf gleicher Höhe teilen sich eine Beschriftung, statt sich zu überlagern.
    const endLabels = (nameOf) => {
      const groups = [];
      S.teams.map((t) => ({ t, v: last.get(t.id) })).sort((p, q) => q.v - p.v).forEach((e) => {
        const g = groups[groups.length - 1];
        if (g && y(e.v) - y(g[g.length - 1].v) < 15) g.push(e); else groups.push([e]);
      });
      return groups.map((g) => ({
        text: g.map((e) => nameOf(e.t)).join(" · "),
        y: g.reduce((sum, e) => sum + y(e.v), 0) / g.length,
      }));
    };
    const width = (labels) => Math.max(...labels.map((l) => l.text.length)) * 6.8 + 12;
    let labels = endLabels((t) => t.name);
    if (W < 600 || width(labels) > W * 0.34) labels = endLabels((t) => initials(t.name));
    const right = Math.min(width(labels), W * 0.34);

    const xs = steps.map((_, i) => left + (W - left - right) * (i / n));
    const every = Math.ceil((n + 1) / Math.max(2, Math.floor((W - left - right) / 40)));
    const grid = gridValues.map((v) =>
      `<line class="chart-grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"></line><text x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
    const ticks = xs.map((x, i) => (i % every ? "" : `<text x="${x}" y="${H - 6}" text-anchor="${i ? "middle" : "start"}">${i || "Start"}</text>`)).join("");
    const lines = S.teams.map((t, i) => {
      const pts = steps.map((st, k) => `${xs[k]},${y(st.vals.get(t.id))}`).join(" ");
      const dots = n <= 14 ? steps.map((st, k) => `<circle class="chart-dot" cx="${xs[k]}" cy="${y(st.vals.get(t.id))}" r="4"></circle>`).join("") : "";
      return `<g style="--c:${teamColor(i)}" data-team="${esc(t.id)}"><polyline class="chart-line" points="${pts}"></polyline>${dots}</g>`;
    }).join("");
    const ends = labels.map((l) => `<text class="chart-end" x="${W - right + 8}" y="${l.y + 4}">${esc(l.text)}</text>`).join("");
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${grid}${ticks}<line class="chart-cross" id="chart-cross" y1="${top}" y2="${H - bottom}" visibility="hidden"></line>${lines}${ends}</svg>`;
    box.setAttribute("aria-label", `${rating ? "Rating" : goals ? "Tore" : "Punkte"} über ${n} ${n === 1 ? "Begegnung" : "Begegnungen"}. Stand: ${S.teams.map((t) => `${t.name} ${last.get(t.id)}`).join(", ")}.`);
    S.chart = { xs, steps, i: null };

    $("#chart-legend").innerHTML = S.teams.map((t, i) => `<span class="chart-key" style="--c:${teamColor(i)}"><i></i>${esc(t.name)}</span>`).join("");
    const head = S.teams.map((t) => `<th title="${esc(t.name)}">${esc(initials(t.name))}</th>`).join("");
    const body = steps.slice(1).map((st, i) => {
      const s = st.series, cells = S.teams.map((t) => `<td>${st.vals.get(t.id)}</td>`).join("");
      return `<tr><td class="l" title="${esc(teamName(s.a))} gegen ${esc(teamName(s.b))}">${i + 1}. ${fmtDate(dayOf(s)).slice(0, 6)}</td>${cells}</tr>`;
    }).join("");
    $("#chart-table").innerHTML = `<table><thead><tr><th class="l">Begegnung</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
    // Neue Daten oder eine neue Breite lassen einen offenen Tooltip stehen.
    if (openStep !== null && openStep <= n) showChartStep(openStep); else hideChartStep();
  }

  // Tooltip: Fadenkreuz am nächsten Schritt, alle Teams auf einen Blick. Namen laufen über textContent.
  function showChartStep(i) {
    const c = S.chart, tip = $("#chart-tip");
    if (!c) return;
    c.i = i;
    const cross = $("#chart-cross");
    cross.setAttribute("x1", c.xs[i]); cross.setAttribute("x2", c.xs[i]); cross.setAttribute("visibility", "visible");
    const { series, vals } = c.steps[i], line = (cls, text) => {
      const el = document.createElement("div");
      el.className = cls; el.textContent = text;
      return el;
    };
    const rows = S.teams.map((t, k) => ({ t, k, v: vals.get(t.id) })).sort((p, q) => q.v - p.v || p.k - q.k).map(({ t, k, v }) => {
      const row = document.createElement("div"), key = document.createElement("i"), value = document.createElement("b");
      row.className = "chart-tip-row"; row.style.setProperty("--c", teamColor(k)); value.textContent = v;
      row.append(key, value, t.name);
      return row;
    });
    const st = series && stats(series), goals = S.chartMetric === "goals";
    const score = series && (goals ? `${st.ga} : ${st.gb}` : `${st.pa} : ${st.pb}`);
    tip.replaceChildren(
      line("chart-tip-head", series ? `Begegnung ${i} · ${fmtDate(dayOf(series)).slice(0, 6)}${st.done ? "" : " · läuft"}` : "Saisonstart"),
      ...(series ? [line("chart-tip-sub", `${teamName(series.a)} ${score} ${teamName(series.b)}`)] : []),
      ...rows,
    );
    tip.hidden = false;
    const W = $("#chart").clientWidth, tw = tip.offsetWidth, x = c.xs[i];
    tip.style.left = `${x + 12 + tw > W ? Math.max(0, x - tw - 12) : x + 12}px`;
  }
  function hideChartStep() {
    const cross = $("#chart-cross");
    if (cross) cross.setAttribute("visibility", "hidden");
    $("#chart-tip").hidden = true;
    if (S.chart) S.chart.i = null;
  }

  function pipsOf(s, st) {
    const pips = Array.from({ length: 5 }, (_, i) => {
      const g = (s.games || [])[i];
      if (g) return `<span class="pip ${g.a > g.b ? "a" : g.b > g.a ? "b" : "d"}" title="Spiel ${i + 1}: ${g.a}:${g.b}"></span>`;
      if (st.state === "live" && i === st.n) return `<span class="pip next" title="Nächstes Spiel"></span>`;
      return `<span class="pip${st.done ? " skip" : ""}"></span>`;
    }).join("");
    return `<span class="pips" aria-label="${st.n} von 5 Spielen gespielt">${pips}</span>`;
  }

  const byNewest = (x, y) => String(y.date || "").localeCompare(String(x.date || "")) || (y.createdAt || 0) - (x.createdAt || 0);
  // Das Datum ist freiwillig: Ohne zählt der Tag, an dem die Begegnung angelegt wurde.
  const dayOf = (s) => s.date || new Date(s.createdAt || 0).toISOString().slice(0, 10);
  const byOldest = (x, y) => dayOf(x).localeCompare(dayOf(y)) || (x.createdAt || 0) - (y.createdAt || 0);

  function fmtDate(d) {
    if (!d) return "";
    const [y, m, day] = d.split("-");
    return y && m && day ? `${day}.${m}.${y}` : d;
  }

  function seriesCard(s, firsts) {
    const st = stats(s), open = S.open.has(s.id), busy = S.busy.has(s.id);
    const nameA = teamName(s.a), nameB = teamName(s.b), lineA = lineupOf(s, "a"), lineB = lineupOf(s, "b");
    const chip = st.draw ? `<span class="chip done">draw</span>` : "";
    let body = "";
    if (open) {
      const rows = (s.games || []).map((g, i) => {
        const wa = g.a > g.b ? "wa" : "", wb = g.b > g.a ? "wb" : "";
        if (!S.canWrite) {
          return `<div class="grow"><span class="gno">Spiel ${i + 1}</span><span class="ro ${wa ? "w ca" : ""}">${g.a}</span><span class="colon">:</span><span class="ro ${wb ? "w cb" : ""}">${g.b}</span><span></span></div>`;
        }
        return `<div class="grow"><span class="gno">Spiel ${i + 1}</span>
          <input type="number" min="0" max="99" inputmode="numeric" class="${wa}" id="e-${s.id}-${i}-a" value="${g.a}" data-act="edit" data-id="${s.id}" data-i="${i}" aria-label="Tore ${esc(nameA)}, Spiel ${i + 1}" ${busy ? "disabled" : ""}>
          <span class="colon">:</span>
          <input type="number" min="0" max="99" inputmode="numeric" class="${wb}" id="e-${s.id}-${i}-b" value="${g.b}" data-act="edit" data-id="${s.id}" data-i="${i}" aria-label="Tore ${esc(nameB)}, Spiel ${i + 1}" ${busy ? "disabled" : ""}>
          <button class="ghost" type="button" data-act="delgame" data-id="${s.id}" data-i="${i}" ${busy ? "disabled" : ""}>Entfernen</button></div>`;
      }).join("");
      const add = S.canWrite && !st.done && st.n < 5
        ? `<div class="grow add"><span class="gno">Spiel ${st.n + 1}</span>
            <input type="number" min="0" max="99" inputmode="numeric" id="n-${s.id}-a" placeholder="0" aria-label="Tore ${esc(nameA)}" data-act="newkey" data-id="${s.id}">
            <span class="colon">:</span>
            <input type="number" min="0" max="99" inputmode="numeric" id="n-${s.id}-b" placeholder="0" aria-label="Tore ${esc(nameB)}" data-act="newkey" data-id="${s.id}">
            <button class="primary" type="button" data-act="addgame" data-id="${s.id}" ${busy ? "disabled" : ""}>Eintragen</button></div>`
        : "";
      const none = !st.n && !add ? `<p class="note">Noch keine Spiele eingetragen.</p>` : "";
      const msg = S.msg[s.id] ? `<p class="err">${esc(S.msg[s.id])}</p>` : "";
      const confirming = S.confirm === s.id;
      const foot = `<div class="series-foot"><span>${st.n ? `Tore gesamt ${st.ga}:${st.gb}` : ""}</span>${S.canWrite ? `<button class="danger${confirming ? " armed" : ""}" type="button" data-act="delseries" data-id="${s.id}" ${busy ? "disabled" : ""}>${confirming ? "Wirklich löschen?" : "Begegnung löschen"}</button>` : ""}</div>`;
      body = `<div class="games">
        <div class="grow headrow"><span></span><span class="ca">${esc(nameA)}</span><span></span><span class="cb">${esc(nameB)}</span><span></span></div>
        ${rows}${add}${none}${msg}${foot}</div>`;
    }
    return `<article class="series panel" data-id="${esc(s.id)}">
      <button class="series-head" type="button" data-act="toggle" data-id="${esc(s.id)}" aria-expanded="${open}">
        <span class="tname ta ${st.winner === "a" ? "won" : ""}">${esc(nameA)}</span>
        <span class="sscore"><span class="ca">${st.pa}</span><span class="x">:</span><span class="cb">${st.pb}</span></span>
        <span class="tname tb ${st.winner === "b" ? "won" : ""}">${esc(nameB)}</span>
        ${lineA.length || lineB.length ? `<span class="tplayers pa">${esc(lineA.join(" · "))}</span><span></span><span class="tplayers">${esc(lineB.join(" · "))}</span>` : ""}
        <span class="meta">${pipsOf(s, st)}<span>${st.n}/5 Spiele${st.d ? ` · ${st.d} ${st.d === 1 ? "draw" : "draws"}` : ""}</span>${chip}${firsts.has(s.id) ? `<span class="chip bonus" title="Erste Begegnung dieser Teams: +1 Punkt für beide">Erstbegegnung +1</span>` : ""}${s.date ? `<span>${fmtDate(s.date)}</span>` : ""}</span>
      </button>${body}</article>`;
  }

  function renderStandings(loaded) {
    const box = $("#standings");
    if (!loaded) { box.innerHTML = emptyBox("Lade Tabelle", "Einen Moment."); return; }
    if (!S.teams.length) { box.innerHTML = emptyBox("Noch keine Teams", "Sobald Teams angelegt und Spiele eingetragen sind, steht hier die Tabelle."); return; }
    const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
    const rows = standings().map((r, i) => {
      const gd = r.gf - r.gag;
      return `<tr><td class="rank">${i + 1}</td><td class="l team">${esc(r.name)}</td><td class="pts" title="${r.pts - r.bonus} aus Ergebnissen + ${r.bonus} Bonus">${r.pts}</td><td>${r.sw}–${r.sd}–${r.sl}</td><td class="opt">${r.gw}–${r.gd}–${r.gl}</td><td class="opt">${r.gf}:${r.gag}</td><td class="${gd > 0 ? "pos" : gd < 0 ? "neg" : ""}">${sign(gd)}</td></tr>`;
    }).join("");
    box.innerHTML = `<table><thead><tr><th>#</th><th class="l">Team</th><th title="Punkte">Pkt</th><th title="Begegnungen: Win – Draw – Lose">Begegn.</th><th class="opt" title="Spiele: Win – Draw – Lose">Spiele</th><th class="opt" title="Tore geschossen : kassiert">Tore</th><th title="Tordifferenz: geschossene minus kassierte Tore">Tordiff.</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderMatrix(loaded) {
    const box = $("#matrix");
    if (!loaded) { box.innerHTML = emptyBox("Lade Paarungen", "Einen Moment."); return; }
    if (S.teams.length < 2) { box.innerHTML = emptyBox("Noch keine Paarungen", "Ab zwei Teams siehst du hier, wer schon gegen wen gespielt hat."); return; }
    const teams = standings();
    const head = `<tr><th></th>${teams.map((t) => `<th class="colh" title="${esc(t.name)}">${esc(initials(t.name))}</th>`).join("")}</tr>`;
    const body = teams.map((r) => {
      const cells = teams.map((c) => {
        if (r.id === c.id) return `<td class="self" aria-label="—"></td>`;
        const ss = S.series.filter((s) => (s.a === r.id && s.b === c.id) || (s.a === c.id && s.b === r.id));
        if (!ss.length) return `<td class="none">–</td>`;
        const parts = ss.map((s) => {
          const st = stats(s), mine = s.a === r.id ? st.pa : st.pb, theirs = s.a === r.id ? st.pb : st.pa;
          return { txt: st.n ? `${mine} : ${theirs}` : "angesetzt", cls: st.done ? (mine > theirs ? "w" : mine < theirs ? "l" : "draw") : st.n ? "live" : "none" };
        });
        const cls = parts.length === 1 ? parts[0].cls : "";
        return `<td class="${cls}">${parts.map((p) => (parts.length > 1 ? `<span class="${p.cls}">${p.txt}</span>` : p.txt)).join(" / ")}</td>`;
      }).join("");
      return `<tr><th class="rowh"><span class="ini">${esc(initials(r.name))}</span>${esc(r.name)}</th>${cells}</tr>`;
    }).join("");
    box.innerHTML = `<table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  function renderTeams(loaded) {
    const box = $("#teams");
    if (!loaded) { box.innerHTML = emptyBox("Lade Teams", "Einen Moment."); return; }
    if (!S.teams.length) { box.innerHTML = `<div class="panel">${emptyBox("Noch keine Teams", S.canWrite ? "Trag oben das erste Team der Winterliga ein." : "Es wurden noch keine Teams angelegt.")}</div>`; return; }
    const table = standings();
    const { ratings } = eloRatings();
    const list = [...S.teams].sort((a, b) => a.name.localeCompare(b.name, "de")).map((t) => {
      const r = table.find((x) => x.id === t.id);
      const tstats = `<div class="tstats"><span>Platz <b>${table.indexOf(r) + 1}</b></span><span><b>${r.pts}</b> Punkte</span><span>Begegn. <b>${r.sw}–${r.sd}–${r.sl}</b></span><span>Spiele <b>${r.gw}–${r.gd}–${r.gl}</b></span><span>Tore <b>${r.gf}:${r.gag}</b></span><span>Rating <b>${ratings.get(t.id)}</b></span></div>`;
      const used = S.series.some((s) => s.a === t.id || s.b === t.id);
      const confirming = S.confirm === "t:" + t.id;
      const btn = S.canWrite
        ? `<button class="${used ? "ghost" : "danger" + (confirming ? " armed" : "")}" type="button" data-act="delteam" data-id="${esc(t.id)}" ${used ? 'disabled title="Team hat Begegnungen – erst die Begegnungen löschen"' : ""}>${confirming ? "Wirklich löschen?" : "Löschen"}</button>`
        : "";
      const key = "t:" + t.id, editing = S.canWrite && S.editTeam === t.id, busy = S.busy.has(key);
      const edit = S.canWrite ? `<button class="ghost" type="button" data-act="editteam" data-id="${esc(t.id)}" aria-expanded="${editing}">${editing ? "Fertig" : "Bearbeiten"}</button>` : "";
      const rename = editing ? `<div class="padd"><input id="tn-${esc(t.id)}" maxlength="40" autocomplete="off" value="${esc(t.name)}" aria-label="Neuer Name für ${esc(t.name)}" data-act="teamnamekey" data-id="${esc(t.id)}"><button class="primary" type="button" data-act="renameteam" data-id="${esc(t.id)}" ${busy ? "disabled" : ""}>Umbenennen</button></div>` : "";
      const removable = t.players.length > MIN_PLAYERS;
      const chips = t.players.map((p, i) => editing && removable
        ? `<span class="player">${esc(p)}<button type="button" data-act="delplayer" data-id="${esc(t.id)}" data-i="${i}" aria-label="${esc(p)} entfernen" ${busy ? "disabled" : ""}>×</button></span>`
        : `<span class="player ro">${esc(p)}</span>`).join("");
      const plist = t.players.length ? `<div class="plist">${chips}</div>` : `<div class="plist none">Keine Spieler eingetragen</div>`;
      const add = editing && t.players.length < MAX_PLAYERS ? `<div class="padd"><input id="p-${esc(t.id)}" maxlength="40" autocomplete="off" placeholder="Spieler hinzufügen" aria-label="Spieler für ${esc(t.name)}" data-act="playerkey" data-id="${esc(t.id)}"><button class="primary" type="button" data-act="addplayer" data-id="${esc(t.id)}" ${busy ? "disabled" : ""}>Hinzufügen</button></div>` : "";
      const hint = editing && !removable ? `<p class="note">Ein Team braucht mindestens ${MIN_PLAYERS} Spieler. Zum Tauschen erst jemanden hinzufügen.</p>` : "";
      const msg = S.msg[key] ? `<p class="err">${esc(S.msg[key])}</p>` : "";
      return `<li class="panel"><div class="trow"><span class="tn">${esc(t.name)}</span><span class="acts">${edit}${btn}</span></div>${rename}${plist}${tstats}${add}${hint}${msg}</li>`;
    }).join("");
    box.innerHTML = `<ul class="teamlist">${list}</ul>`;
  }

  // ---------- writes ----------
  function onWriteError(e, where) {
    S.msg[where] = (e && e.message) || "Speichern hat nicht geklappt. Versuch es noch einmal."; render();
  }
  async function withBusy(id, fn) {
    if (S.busy.has(id)) return;
    S.busy.add(id); render();
    try { await fn(); }
    catch (e) { onWriteError(e, id); }
    finally { S.busy.delete(id); render(); }
  }
  function parseScore(v) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
  }
  function validGame(a, b) {
    if (a == null || b == null) return "Trag für beide Teams eine Toranzahl ein (0–99).";
    return null;
  }
  const getSeries = (id) => S.series.find((s) => s.id === id);

  async function addGame(id) {
    const s = getSeries(id); if (!s) return;
    const a = parseScore($(`#n-${id}-a`).value), b = parseScore($(`#n-${id}-b`).value);
    const bad = validGame(a, b);
    if (bad) { S.msg[id] = bad; render(); return; }
    if (stats(s).done) { S.msg[id] = "Die Begegnung ist schon entschieden."; render(); return; }
    delete S.msg[id];
    const games = [...(s.games || []).map((g) => ({ a: g.a, b: g.b })), { a, b }];
    await withBusy(id, async () => {
      await api("PATCH", "/api/series/" + id, { games });
      const ea = $(`#n-${id}-a`), eb = $(`#n-${id}-b`);
      if (ea) ea.value = ""; if (eb) eb.value = "";
    });
    const ea = $(`#n-${id}-a`), eb = $(`#n-${id}-b`);
    if (ea) { ea.value = ""; eb.value = ""; ea.focus(); }
  }
  async function editGame(id, i) {
    const s = getSeries(id); if (!s) return;
    const a = parseScore($(`#e-${id}-${i}-a`).value), b = parseScore($(`#e-${id}-${i}-b`).value);
    const bad = validGame(a, b);
    if (bad) { S.msg[id] = bad; render(); return; }
    const old = (s.games || [])[i];
    if (old && old.a === a && old.b === b) { delete S.msg[id]; return; }
    delete S.msg[id];
    const games = (s.games || []).map((g, k) => (k === i ? { a, b } : { a: g.a, b: g.b }));
    await withBusy(id, () => api("PATCH", "/api/series/" + id, { games }));
  }
  async function delGame(id, i) {
    const s = getSeries(id); if (!s) return;
    const games = (s.games || []).filter((_, k) => k !== i).map((g) => ({ a: g.a, b: g.b }));
    delete S.msg[id];
    await withBusy(id, () => api("PATCH", "/api/series/" + id, { games }));
  }

  function cleanPlayers(list) {
    const out = [];
    list.map((p) => p.trim().replace(/\s+/g, " ").slice(0, 40)).filter(Boolean)
      .forEach((p) => { if (!out.some((q) => q.toLowerCase() === p.toLowerCase())) out.push(p); });
    return out.slice(0, MAX_PLAYERS);
  }
  // Begegnungen verweisen über die Team-ID aufs Team, ein neuer Name lässt Spiele und Punkte also unberührt.
  async function renameTeam(id) {
    const t = S.teams.find((x) => x.id === id), input = document.getElementById("tn-" + id);
    if (!t || !input) return;
    const key = "t:" + id, name = input.value.trim().replace(/\s+/g, " ");
    delete S.msg[key];
    if (!name) { S.msg[key] = "Gib einen Teamnamen ein."; render(); return; }
    if (S.teams.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) { S.msg[key] = `„${name}“ gibt es schon.`; render(); return; }
    if (name === t.name) { input.value = name; render(); return; }
    await withBusy(key, () => api("PATCH", "/api/teams/" + id, { name }));
  }
  async function addPlayer(id) {
    const t = S.teams.find((x) => x.id === id), input = document.getElementById("p-" + id);
    if (!t || !input) return;
    const key = "t:" + id, name = input.value.trim().replace(/\s+/g, " ");
    if (!name) { input.focus(); return; }
    if (t.players.some((p) => p.toLowerCase() === name.toLowerCase())) { S.msg[key] = `„${name}“ ist schon im Team.`; render(); return; }
    if (t.players.length >= MAX_PLAYERS) { S.msg[key] = `Ein Team hat höchstens ${MAX_PLAYERS} Spieler. Entferne erst einen.`; render(); return; }
    delete S.msg[key];
    await withBusy(key, () => api("PATCH", "/api/teams/" + id, { players: cleanPlayers([...t.players, name]) }));
    const el = document.getElementById("p-" + id);
    if (el) { el.value = ""; el.focus(); }
  }
  async function delPlayer(id, i) {
    const t = S.teams.find((x) => x.id === id); if (!t) return;
    delete S.msg["t:" + id];
    await withBusy("t:" + id, () => api("PATCH", "/api/teams/" + id, { players: t.players.filter((_, k) => k !== i) }));
  }

  // ---------- events ----------
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]"); if (!el) return;
    const { act, id } = el.dataset, i = Number(el.dataset.i);
    if (act !== "delseries" && act !== "delteam" && S.confirm) S.confirm = null;
    if (act === "toggle") { S.open.has(id) ? S.open.delete(id) : S.open.add(id); render(); }
    else if (act === "openseries") { S.open.add(id); S.scrollTo = id; render(); }
    else if (act === "rules") { ev.preventDefault(); setRules(!S.rules); }
    else if (act === "shuffle") { S.factIds = pickFacts(S.factIds); renderFacts(true); }
    else if (act === "chartmetric") { S.chartMetric = el.dataset.metric; renderChart(); }
    else if (act === "addgame") addGame(id);
    else if (act === "editteam") { S.editTeam = S.editTeam === id ? null : id; delete S.msg["t:" + id]; render(); if (S.editTeam) { const el = document.getElementById("p-" + id); if (el) el.focus(); } }
    else if (act === "renameteam") renameTeam(id);
    else if (act === "addplayer") addPlayer(id);
    else if (act === "delplayer") delPlayer(id, i);
    else if (act === "delgame") delGame(id, i);
    else if (act === "delseries") {
      if (S.confirm !== id) { S.confirm = id; render(); return; }
      S.confirm = null; S.open.delete(id);
      withBusy(id, () => api("DELETE", "/api/series/" + id));
    } else if (act === "delteam") {
      const key = "t:" + id;
      if (S.confirm !== key) { S.confirm = key; render(); return; }
      S.confirm = null;
      withBusy(key, () => api("DELETE", "/api/teams/" + id));
    }
  });
  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.act === "edit") editGame(el.dataset.id, Number(el.dataset.i));
    if (el.id === "series-a" || el.id === "series-b") { S.pick[el.id.slice(-1)] = []; renderLineupPick(); }
    if (el.dataset && el.dataset.act === "pick") {
      const side = el.dataset.side;
      S.pick[side] = el.checked ? [...S.pick[side], el.value] : S.pick[side].filter((p) => p !== el.value);
      $("#series-err").hidden = true;
      renderLineupPick();
      document.getElementById(el.id).focus();
    }
  });
  document.addEventListener("keydown", (ev) => {
    const el = ev.target;
    if (ev.key === "Enter" && el.dataset && el.dataset.act === "newkey") { ev.preventDefault(); addGame(el.dataset.id); }
    if (ev.key === "Enter" && el.dataset && el.dataset.act === "playerkey") { ev.preventDefault(); addPlayer(el.dataset.id); }
    if (ev.key === "Enter" && el.dataset && el.dataset.act === "teamnamekey") { ev.preventDefault(); renameTeam(el.dataset.id); }
  });

  $("#team-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = $("#team-name"), err = $("#team-err");
    const name = input.value.trim().replace(/\s+/g, " ");
    err.hidden = true;
    if (!name) { err.textContent = "Gib einen Teamnamen ein."; err.hidden = false; return; }
    if (S.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) { err.textContent = `„${name}“ gibt es schon.`; err.hidden = false; return; }
    try {
      const raw = $("#team-players").value.split(",").map((p) => p.trim()).filter(Boolean);
      if (raw.length > MAX_PLAYERS) { err.textContent = `Ein Team hat höchstens ${MAX_PLAYERS} Spieler.`; err.hidden = false; return; }
      const players = cleanPlayers(raw);
      if (players.length < MIN_PLAYERS) { err.textContent = `Ein Team braucht mindestens ${MIN_PLAYERS} Spieler.`; err.hidden = false; return; }
      await api("POST", "/api/teams", { name, players });
      input.value = ""; $("#team-players").value = ""; input.focus();
    } catch (e) {
      err.textContent = (e && e.message) || "Speichern hat nicht geklappt. Versuch es noch einmal.";
      err.hidden = false;
    }
  });

  $("#series-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = $("#series-a").value, b = $("#series-b").value, date = $("#series-date").value, err = $("#series-err");
    err.hidden = true;
    if (!a || !b) { err.textContent = "Wähle zwei Teams aus."; err.hidden = false; return; }
    if (a === b) { err.textContent = "Ein Team kann nicht gegen sich selbst spielen."; err.hidden = false; return; }
    const unpicked = [["a", a], ["b", b]].find(([side, id]) => playersOf(id).length > 2 && S.pick[side].length !== 2);
    if (unpicked) { err.textContent = `Wähle für „${teamName(unpicked[1])}“ die 2 Spieler aus, die spielen.`; err.hidden = false; return; }
    const btn = ev.submitter || $("#series-form button");
    btn.disabled = true;
    try {
      const res = await api("POST", "/api/series", { a, b, lineupA: S.pick.a, lineupB: S.pick.b, date: date || null });
      if (res.id) S.open.add(res.id);
      $("#series-a").value = ""; $("#series-b").value = ""; $("#series-date").value = "";
      render();
    } catch (e) {
      err.textContent = (e && e.message) || "Speichern hat nicht geklappt. Versuch es noch einmal.";
      err.hidden = false;
    } finally { btn.disabled = false; }
  });

  // ---------- Orga-Login ----------
  $("#login-open").addEventListener("click", () => { $("#login-form").hidden = false; $("#login-err").hidden = true; $("#login-pass").focus(); });
  $("#login-cancel").addEventListener("click", () => { $("#login-form").hidden = true; $("#login-pass").value = ""; });
  $("#logout").addEventListener("click", () => { setKey(null); S.editTeam = null; S.confirm = null; render(); });
  $("#login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pass = $("#login-pass").value, err = $("#login-err");
    err.hidden = true;
    if (!pass) { $("#login-pass").focus(); return; }
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { Authorization: "Bearer " + pass } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { err.textContent = data.error || "Anmeldung hat nicht geklappt."; err.hidden = false; return; }
      setKey(pass); $("#login-pass").value = ""; render();
    } catch (_) { err.textContent = "Keine Verbindung zum Server."; err.hidden = false; }
  });

  // ---------- Bereiche ----------
  // Der Bereich steht in der Adresse, damit Links wie /#regeln und der Zurück-Knopf funktionieren.
  function showView() {
    let hash = location.hash.slice(1);
    // /#regeln ist ein Direktlink auf den Regel-Block: Er klappt auf, der Bereich darunter bleibt.
    if (hash === "regeln") { hash = S.view; history.replaceState(null, "", "#" + hash); setRules(true); }
    const view = S.view = VIEWS.includes(hash) ? hash : VIEWS[0];
    VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
    document.querySelectorAll(".tabs a").forEach((a) => {
      if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    scrollToTabs();
    const card = [...document.querySelectorAll("article.series")].find((a) => a.dataset.id === S.scrollTo);
    if (card) { card.scrollIntoView({ block: "start" }); S.scrollTo = null; }
  }
  window.addEventListener("hashchange", showView);
  window.addEventListener("winterliga:refresh", refresh);

  // Die Reiter kleben oben, der Inhalt darunter kann längst weggescrollt sein: Zurück an den Anfang direkt unter den Reitern.
  function scrollToTabs() {
    const top = $(".board").getBoundingClientRect().bottom + window.scrollY;
    if (window.scrollY > top) window.scrollTo(0, top);
  }

  // ---------- Regeln ----------
  function setRules(open) {
    if (open === S.rules) return;
    S.rules = open;
    document.body.classList.toggle("rules-open", open);
    $("#rules-toggle").setAttribute("aria-expanded", String(open));
    if (open) scrollToTabs();
  }

  // ---------- Saisonverlauf ----------
  const chartEl = $("#chart");
  const nearestStep = (ev) => {
    const x = ev.clientX - chartEl.getBoundingClientRect().left, { xs } = S.chart;
    return xs.reduce((best, v, i) => (Math.abs(v - x) < Math.abs(xs[best] - x) ? i : best), 0);
  };
  ["pointermove", "pointerdown"].forEach((type) => chartEl.addEventListener(type, (ev) => { if (S.chart) showChartStep(nearestStep(ev)); }));
  // Auf Touch-Geräten bleibt der Wert nach dem Antippen stehen, die Maus blendet ihn beim Verlassen aus.
  chartEl.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") hideChartStep(); });
  chartEl.addEventListener("blur", hideChartStep);
  chartEl.addEventListener("keydown", (ev) => {
    const c = S.chart, dir = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
    if (!c || !dir) return;
    ev.preventDefault();
    showChartStep(Math.min(c.steps.length - 1, Math.max(0, c.i === null ? c.steps.length - 1 : c.i + dir)));
  });
  // Die Kurve wird für die echte Breite gezeichnet, also auch dann, wenn der Bereich erst sichtbar wird.
  new ResizeObserver(() => { if (chartEl.clientWidth !== S.chartW) renderChart(); }).observe(chartEl);

  // ---------- Start ----------
  showView();
  render();
  refresh();
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 15000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
})();
