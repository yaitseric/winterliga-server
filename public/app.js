"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MAX_PLAYERS = 3;
  const VIEWS = ["tabelle", "begegnungen", "teams"];
  const S = {
    teams: [], series: [], tLoaded: false, sLoaded: false,
    canWrite: false, key: null, etag: null, offline: false,
    open: new Set(), editTeam: null, confirm: null, busy: new Set(), msg: {},
    pick: { a: [], b: [] }, pickHtml: { a: "", b: "" },
    view: VIEWS[0], rules: false, rulesPushed: false, scrollTo: null,
  };

  // ---------- Server ----------
  const KEY_STORE = "winterliga-orga";
  try { S.key = localStorage.getItem(KEY_STORE); S.canWrite = !!S.key; } catch (_) {}
  function setKey(k) {
    S.key = k; S.canWrite = !!k;
    try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch (_) {}
  }
  function applyState(st) {
    S.teams = (st.teams || []).map((t) => ({ id: t.id, name: String(t.name || "Team"), players: Array.isArray(t.players) ? t.players : [] }));
    S.series = (st.series || []).map((s) => ({ id: s.id, a: s.a, b: s.b, lineupA: Array.isArray(s.lineupA) ? s.lineupA : [], lineupB: Array.isArray(s.lineupB) ? s.lineupB : [], date: s.date || null, createdAt: s.createdAt || 0, games: Array.isArray(s.games) ? s.games : [] }));
    S.tLoaded = S.sLoaded = true;
    S.etag = `"${st.rev}"`;
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
        if (st.winner === "a") { A.sw++; B.sl++; A.pts += 2; } else if (st.winner === "b") { B.sw++; A.sl++; B.pts += 2; } else { A.sd++; B.sd++; A.pts++; B.pts++; }
        if (firsts.has(s.id)) { A.pts++; B.pts++; A.bonus++; B.bonus++; }
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
      if (el) { el.focus(); try { if (focus.s != null) el.setSelectionRange(focus.s, focus.e); } catch (_) {} }
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
          : "Wähle oben zwei Teams und lege die erste Begegnung an. Jede Begegnung geht über maximal fünf Spiele. Sie ist entschieden, sobald ein Team nicht mehr eingeholt werden kann, und kann auch unentschieden enden.")}</div>`;
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
        <span class="rscore"><span class="ca">${st.pa}</span>:<span class="cb">${st.pb}</span></span>
        <span class="rteam tb${st.winner === "b" ? " won" : ""}">${esc(teamName(s.b))}</span>
      </a>`;
    }).join("");
  }

  function renderFacts(loaded) {
    const games = loaded ? S.series.flatMap((s) => s.games.map((g) => ({ ...g, s }))) : [];
    $("#facts-box").hidden = !games.length;
    if (!games.length) return;
    const goals = games.reduce((n, g) => n + g.a + g.b, 0);
    const top = standings().reduce((best, r) => (r.gf > best.gf ? r : best));
    // Höchster Sieg nach Tordifferenz, bei Gleichstand das torreichere Spiel.
    const big = games.filter((g) => g.a !== g.b).sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b) || (y.a + y.b) - (x.a + x.b))[0];
    const tile = (value, label, sub) => `<div class="tile panel"><b>${value}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
    $("#facts").innerHTML = [
      tile(goals, "Tore", `in ${games.length} ${games.length === 1 ? "Spiel" : "Spielen"}`),
      tile(Math.round(goals / games.length * 10) / 10, "Tore pro Spiel"),
      big ? tile(`${Math.max(big.a, big.b)}:${Math.min(big.a, big.b)}`, "Höchster Sieg", `${esc(teamName(big.a > big.b ? big.s.a : big.s.b))} gegen ${esc(teamName(big.a > big.b ? big.s.b : big.s.a))}`) : "",
      tile(top.gf, "Meiste Tore", esc(top.name)),
    ].join("");
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

  function fmtDate(d) {
    if (!d) return "";
    const [y, m, day] = d.split("-");
    return y && m && day ? `${day}.${m}.${y}` : d;
  }

  function seriesCard(s, firsts) {
    const st = stats(s), open = S.open.has(s.id), busy = S.busy.has(s.id);
    const nameA = teamName(s.a), nameB = teamName(s.b), lineA = lineupOf(s, "a"), lineB = lineupOf(s, "b");
    const chip = st.draw ? `<span class="chip done">unentschieden</span>` : "";
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
      const foot = `<div class="series-foot"><span>${st.n ? `Tore gesamt ${st.ga}:${st.gb}` : ""}${s.date ? ` · ${fmtDate(s.date)}` : ""}</span>${S.canWrite ? `<button class="danger${confirming ? " armed" : ""}" type="button" data-act="delseries" data-id="${s.id}" ${busy ? "disabled" : ""}>${confirming ? "Wirklich löschen?" : "Begegnung löschen"}</button>` : ""}</div>`;
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
        <span class="meta">${pipsOf(s, st)}<span>${st.n}/5 Spiele${st.d ? ` · ${st.d} remis` : ""}</span>${chip}${firsts.has(s.id) ? `<span class="chip bonus" title="Erste Begegnung dieser Teams: +1 Punkt für beide">Erstbegegnung +1</span>` : ""}${s.date ? `<span>${fmtDate(s.date)}</span>` : ""}</span>
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
    box.innerHTML = `<table><thead><tr><th>#</th><th class="l">Team</th><th title="Punkte">Pkt</th><th title="Begegnungen gewonnen – unentschieden – verloren">Begegn.</th><th class="opt" title="Spiele gewonnen – unentschieden – verloren">Spiele</th><th class="opt" title="Tore geschossen : kassiert">Tore</th><th title="Tordifferenz: geschossene minus kassierte Tore">Tordiff.</th></tr></thead><tbody>${rows}</tbody></table>`;
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
          return { txt: st.n ? `${mine}:${theirs}` : "angesetzt", cls: st.done ? (mine > theirs ? "w" : mine < theirs ? "l" : "draw") : st.n ? "live" : "none" };
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
    const list = [...S.teams].sort((a, b) => a.name.localeCompare(b.name, "de")).map((t) => {
      const r = table.find((x) => x.id === t.id);
      const tstats = `<div class="tstats"><span>Platz <b>${table.indexOf(r) + 1}</b></span><span><b>${r.pts}</b> Punkte</span><span>Begegn. <b>${r.sw}–${r.sd}–${r.sl}</b></span><span>Spiele <b>${r.gw}–${r.gd}–${r.gl}</b></span><span>Tore <b>${r.gf}:${r.gag}</b></span></div>`;
      const used = S.series.some((s) => s.a === t.id || s.b === t.id);
      const confirming = S.confirm === "t:" + t.id;
      const btn = S.canWrite
        ? `<button class="${used ? "ghost" : "danger" + (confirming ? " armed" : "")}" type="button" data-act="delteam" data-id="${esc(t.id)}" ${used ? 'disabled title="Team hat Begegnungen – erst die Begegnungen löschen"' : ""}>${confirming ? "Wirklich löschen?" : "Löschen"}</button>`
        : "";
      const key = "t:" + t.id, editing = S.canWrite && S.editTeam === t.id, busy = S.busy.has(key);
      const edit = S.canWrite ? `<button class="ghost" type="button" data-act="editteam" data-id="${esc(t.id)}" aria-expanded="${editing}">${editing ? "Fertig" : "Spieler"}</button>` : "";
      const chips = t.players.map((p, i) => editing
        ? `<span class="player">${esc(p)}<button type="button" data-act="delplayer" data-id="${esc(t.id)}" data-i="${i}" aria-label="${esc(p)} entfernen" ${busy ? "disabled" : ""}>×</button></span>`
        : `<span class="player ro">${esc(p)}</span>`).join("");
      const plist = t.players.length ? `<div class="plist">${chips}</div>` : `<div class="plist none">Keine Spieler eingetragen</div>`;
      const add = editing && t.players.length < MAX_PLAYERS ? `<div class="padd"><input id="p-${esc(t.id)}" maxlength="40" autocomplete="off" placeholder="Spieler hinzufügen" aria-label="Spieler für ${esc(t.name)}" data-act="playerkey" data-id="${esc(t.id)}"><button class="primary" type="button" data-act="addplayer" data-id="${esc(t.id)}" ${busy ? "disabled" : ""}>Hinzufügen</button></div>` : "";
      const msg = S.msg[key] ? `<p class="err">${esc(S.msg[key])}</p>` : "";
      return `<li class="panel"><div class="trow"><span class="tn">${esc(t.name)}</span><span class="acts">${edit}${btn}</span></div>${plist}${tstats}${add}${msg}</li>`;
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
    else if (act === "addgame") addGame(id);
    else if (act === "editteam") { S.editTeam = S.editTeam === id ? null : id; delete S.msg["t:" + id]; render(); if (S.editTeam) { const el = document.getElementById("p-" + id); if (el) el.focus(); } }
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
    if (ev.key === "Escape" && S.rules) setRules(false);
    if (ev.key === "Enter" && el.dataset && el.dataset.act === "newkey") { ev.preventDefault(); addGame(el.dataset.id); }
    if (ev.key === "Enter" && el.dataset && el.dataset.act === "playerkey") { ev.preventDefault(); addPlayer(el.dataset.id); }
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
    // /#regeln ist ein Direktlink auf die Leiste: Sie geht auf, der Bereich dahinter bleibt.
    if (hash === "regeln") { hash = S.view; history.replaceState(null, "", "#" + hash); setRules(true); }
    const view = S.view = VIEWS.includes(hash) ? hash : VIEWS[0];
    VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
    document.querySelectorAll(".tabs a").forEach((a) => {
      if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    // Die Reiter kleben oben: Beim Wechsel beginnt der neue Bereich direkt darunter statt mitten in der Seite.
    const top = $(".board").getBoundingClientRect().bottom + window.scrollY;
    if (window.scrollY > top) window.scrollTo(0, top);
    const card = [...document.querySelectorAll("article.series")].find((a) => a.dataset.id === S.scrollTo);
    if (card) { card.scrollIntoView({ block: "start" }); S.scrollTo = null; }
  }
  window.addEventListener("hashchange", showView);

  // ---------- Regeln ----------
  // Auf breiten Bildschirmen rückt die Seite zur Seite und bleibt bedienbar. Schmal bedeckt die Leiste alles,
  // deshalb schließt sie dort der Zurück-Knopf, statt die Seite zu verlassen.
  const rulesCover = window.matchMedia("(max-width: 860px)");
  function setRules(open, fromHistory = false) {
    if (open === S.rules) return;
    S.rules = open;
    document.body.classList.toggle("rules-open", open);
    $("#rules-toggle").setAttribute("aria-expanded", String(open));
    (open ? $("#rules-close") : $("#rules-toggle")).focus({ preventScroll: true });
    if (open && rulesCover.matches) { history.pushState(null, ""); S.rulesPushed = true; }
    else if (!open && S.rulesPushed) { S.rulesPushed = false; if (!fromHistory) history.back(); }
  }
  window.addEventListener("popstate", () => { if (S.rulesPushed) setRules(false, true); });

  // ---------- Start ----------
  showView();
  render();
  refresh();
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 15000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
})();
