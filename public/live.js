/* Live scorer for Winterliga Dresden.
   Uses the existing /api/state and /api/series API. */
"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);

  const state = {
    teams: [],
    series: []
  };

  const game = {
    a: 0,
    b: 0,
    seriesId: null,
    remaining: 12 * 60 * 1000,
    duration: 12,
    running: false,
    deadline: 0,
    interval: null,
    saving: false
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

  function isLiveMode() {
    const active = location.hash === "#live";
    document.body.classList.toggle("live-mode", active);

    if (active) {
      window.scrollTo(0, 0);
      loadState();
    }
  }

  async function loadState() {
    try {
      const response = await fetch("/api/state", {
        cache: "no-store"
      });

      if (!response.ok) throw new Error("state");

      const data = await response.json();

      state.teams = Array.isArray(data.teams) ? data.teams : [];
      state.series = Array.isArray(data.series) ? data.series : [];

      fillTeamSelects();
      resolveEncounter();

    } catch (_) {
      showMessage(
        "Spielstände konnten nicht geladen werden. Bitte Verbindung prüfen.",
        true
      );
    }
  }

  function fillTeamSelects() {
    const options =
      '<option value="">Team auswählen</option>' +
      [...state.teams]
        .sort((a, b) => a.name.localeCompare(b.name, "de"))
        .map((team) =>
          `<option value="${esc(team.id)}">${esc(team.name)}</option>`
        )
        .join("");

    const oldA = $("#live-team-a").value;
    const oldB = $("#live-team-b").value;

    $("#live-team-a").innerHTML = options;
    $("#live-team-b").innerHTML = options;

    if (state.teams.some((t) => t.id === oldA)) {
      $("#live-team-a").value = oldA;
    }

    if (state.teams.some((t) => t.id === oldB)) {
      $("#live-team-b").value = oldB;
    }
  }

  function seriesStats(series) {
    let winsA = 0;
    let winsB = 0;
    let draws = 0;

    for (const score of series.games || []) {
      if (score.a > score.b) winsA++;
      else if (score.b > score.a) winsB++;
      else draws++;
    }

    const n = (series.games || []).length;
    const remaining = Math.max(0, 5 - n);

    const done =
      n >= 5 ||
      winsA > winsB + remaining ||
      winsB > winsA + remaining;

    return {
      winsA,
      winsB,
      draws,
      n,
      done
    };
  }

  function resolveEncounter() {
    const a = $("#live-team-a").value;
    const b = $("#live-team-b").value;
    const select = $("#live-encounter");

    select.innerHTML = "";
    game.seriesId = null;

    if (!a || !b) {
      select.hidden = true;
      showMessage("Wähle die beiden Teams aus.");
      updateControls();
      return;
    }

    if (a === b) {
      select.hidden = true;
      showMessage("Ein Team kann nicht gegen sich selbst spielen.", true);
      updateControls();
      return;
    }

    const candidates = state.series.filter((s) =>
      (
        (s.a === a && s.b === b) ||
        (s.a === b && s.b === a)
      ) &&
      !seriesStats(s).done
    );

    if (!candidates.length) {
      select.hidden = true;
      showMessage(
        "Für diese Paarung gibt es keine offene Begegnung. " +
        "Lege sie zuerst im Bereich „Begegnungen“ an.",
        true
      );
      updateControls();
      return;
    }

    if (candidates.length === 1) {
      game.seriesId = candidates[0].id;
      select.hidden = true;
      showMessage(encounterDescription(candidates[0]));

    } else {
      select.hidden = false;

      select.innerHTML =
        '<option value="">Begegnung auswählen</option>' +
        candidates
          .map((s) =>
            `<option value="${esc(s.id)}">${esc(encounterDescription(s))}</option>`
          )
          .join("");

      showMessage(
        "Für diese Paarung gibt es mehrere offene Begegnungen. " +
        "Wähle die richtige aus."
      );
    }

    updateControls();
  }

  function encounterDescription(series) {
    const nameA =
      state.teams.find((t) => t.id === series.a)?.name || "Team A";

    const nameB =
      state.teams.find((t) => t.id === series.b)?.name || "Team B";

    const result = seriesStats(series);

    return `${nameA} – ${nameB} (${result.n}/5 Spiele${series.date ? ", " + series.date : ""})`;
  }

  function showMessage(message, error = false) {
    const box = $("#live-message");

    box.textContent = message;
    box.classList.toggle("error", error);
  }

  function selectedEncounter() {
    return state.series.find(
      (s) => s.id === (game.seriesId || $("#live-encounter").value)
    ) || null;
  }

  function formatTime(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));

    return (
      `${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
      `${String(seconds % 60).padStart(2, "0")}`
    );
  }

  function renderTimer() {
    if (game.running) {
      game.remaining = Math.max(0, game.deadline - Date.now());
    }

    $("#live-clock").textContent = formatTime(game.remaining);

    $("#live-clock").classList.toggle(
      "expired",
      game.remaining === 0
    );

    $("#live-start").textContent =
      game.running
        ? "Pause"
        : game.remaining === 0
          ? "Abgelaufen"
          : "Start";

    $("#live-start").disabled = game.remaining === 0;
  }

  function stopTimer() {
    game.running = false;

    if (game.interval) {
      clearInterval(game.interval);
    }

    game.interval = null;
    renderTimer();
  }

  function startPauseTimer() {
    if (game.running) {
      game.remaining = Math.max(0, game.deadline - Date.now());
      stopTimer();
      return;
    }

    if (game.remaining <= 0) return;

    game.deadline = Date.now() + game.remaining;
    game.running = true;

    game.interval = setInterval(() => {
      renderTimer();

      if (game.remaining <= 0) {
        stopTimer();
      }
    }, 100);

    renderTimer();
  }

  function resetTimer() {
    stopTimer();

    const entered = Number($("#live-duration").value);

    game.duration =
      Number.isFinite(entered) && entered >= 1 && entered <= 60
        ? entered
        : 12;

    $("#live-duration").value = String(game.duration);

    game.remaining = game.duration * 60 * 1000;

    renderTimer();
  }

  function renderScore() {
    $("#live-score-a").textContent = String(game.a);
    $("#live-score-b").textContent = String(game.b);

    // Disable decrement buttons when the corresponding score is zero.
    document.querySelectorAll("[data-live-score]").forEach((button) => {
      const [side, delta] = button.dataset.liveScore.split(":");

      button.disabled =
        !selectedEncounter() ||
        game.saving ||
        (Number(delta) < 0 && game[side] <= 0);
    });
  }

  function updateControls() {
    const encounter = selectedEncounter();

    const canSave =
      !!encounter &&
      !seriesStats(encounter).done &&
      !game.saving;

    $("#live-save").disabled = !canSave;

    $("#live-team-a").disabled = game.saving;
    $("#live-team-b").disabled = game.saving;
    $("#live-encounter").disabled = game.saving;

    $("#live-score-controls").classList.toggle(
      "disabled",
      !canSave
    );

    renderScore();
  }

  async function saveGame() {
    const encounter = selectedEncounter();

    if (!encounter || game.saving) return;

    if (
      !Number.isInteger(game.a) ||
      !Number.isInteger(game.b) ||
      game.a < 0 ||
      game.b < 0
    ) {
      return;
    }

    const key = (() => {
      try {
        return localStorage.getItem("winterliga-orga");
      } catch (_) {
        return null;
      }
    })();

    if (!key) {
      showMessage(
        "Zum Speichern musst du zuerst oben im Orga-Login angemeldet sein.",
        true
      );
      return;
    }

    // The dropdown order may differ from the stored encounter order.
    // Map the visible top/bottom scores to the encounter's a/b sides.
    const selectedA = $("#live-team-a").value;
    const selectedB = $("#live-team-b").value;

    const score = encounter.a === selectedA
      ? { a: game.a, b: game.b }
      : { a: game.b, b: game.a };

    const nextGames = [
      ...(encounter.games || []),
      score
    ];

    if (nextGames.length > 5) {
      showMessage("Diese Begegnung hat bereits fünf Spiele.", true);
      return;
    }

    const teamAName = state.teams.find((team) => team.id === selectedA)?.name || "Team 1";
    const teamBName = state.teams.find((team) => team.id === selectedB)?.name || "Team 2";

    const confirmed = window.confirm(
    `Spiel wirklich speichern?\n\n${teamAName}  ${game.a} : ${game.b}  ${teamBName}\n\nDas Ergebnis wird dauerhaft übernommen.`
    );

    if (!confirmed) return;

    game.saving = true;

    stopTimer();
    updateControls();

    $("#live-save").textContent = "Speichert …";

    try {
      const response = await fetch(
        `/api/series/${encodeURIComponent(encounter.id)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`
          },
          body: JSON.stringify({
            games: nextGames
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Spiel konnte nicht gespeichert werden."
        );
      }

      if (data.state) {
        state.teams = data.state.teams || state.teams;
        state.series = data.state.series || state.series;
      } else {
        encounter.games = nextGames;
      }

      const updated =
        state.series.find((s) => s.id === encounter.id) ||
        { ...encounter, games: nextGames };

      const result = seriesStats(updated);

      game.a = 0;
      game.b = 0;

      resetTimer();
      renderScore();

      window.dispatchEvent(
        new CustomEvent("winterliga:refresh")
      );

      if (result.done) {
        const winner =
          result.winsA > result.winsB
            ? state.teams.find((t) => t.id === updated.a)?.name
            : result.winsB > result.winsA
              ? state.teams.find((t) => t.id === updated.b)?.name
              : null;

        showMessage(
          winner
            ? `Begegnung entschieden: ${winner} gewinnt.`
            : "Begegnung beendet: Draw."
        );

      } else {
        showMessage(
          `Spiel gespeichert (${result.n}/5). Nächstes Spiel kann beginnen.`
        );
      }

    } catch (error) {
      showMessage(
        error.message || "Speichern hat nicht geklappt.",
        true
      );

    } finally {
      game.saving = false;

      $("#live-save").textContent = "Spiel speichern";

      updateControls();
    }
  }

  // Score buttons
  document.querySelectorAll("[data-live-score]").forEach((button) => {
    button.addEventListener("click", () => {
      if (game.saving || !selectedEncounter()) return;

      const [side, delta] = button.dataset.liveScore.split(":");

      game[side] = Math.max(
        0,
        Math.min(99, game[side] + Number(delta))
      );

      renderScore();

      // Stop the timer when the score difference reaches five goals.
      if (Math.abs(game.a - game.b) >= 5 && game.running) {
        stopTimer();

        showMessage(
          "5 Tore Unterschied: Das Spiel ist vorbei. Ergebnis jetzt speichern."
        );
      }
    });
  });

  // Team selection
  $("#live-team-a").addEventListener(
    "change",
    resolveEncounter
  );

  $("#live-team-b").addEventListener(
    "change",
    resolveEncounter
  );

  // Encounter selection
  $("#live-encounter").addEventListener("change", () => {
    game.seriesId = $("#live-encounter").value || null;

    const encounter = selectedEncounter();

    if (encounter) {
      showMessage(encounterDescription(encounter));
    }

    updateControls();
  });

  // Timer controls
  $("#live-start").addEventListener(
    "click",
    startPauseTimer
  );

  $("#live-reset").addEventListener(
    "click",
    resetTimer
  );

  $("#live-duration").addEventListener(
    "change",
    resetTimer
  );

  // Save game
  $("#live-save").addEventListener(
    "click",
    saveGame
  );

  // Return to league overview
  $("#live-back").addEventListener("click", () => {
    location.hash = "#tabelle";
  });

  // Navigation and refresh events
  window.addEventListener(
    "hashchange",
    isLiveMode
  );

  window.addEventListener(
    "winterliga:refresh",
    loadState
  );

  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      location.hash === "#live"
    ) {
      loadState();
    }
  });

  // Initial setup
  renderScore();
  resetTimer();
  isLiveMode();

})();