/* ========================================================================
   Planning Poker — client app (vanilla JS)
   ======================================================================== */

(function () {
  "use strict";

  // Fibonacci scale within 1–10 (the widening gaps force discussion when
  // uncertainty is high — the point of relative estimation). Plus the standard
  // "?" (need more info) and "☕" (break) cards.
  var DECK_VALUES = [
    "1", "2", "3", "5", "8", "?", "☕"
  ];
  var NAME_STORAGE_KEY = "planningPoker.name";
  var PLAYER_ID_STORAGE_KEY = "planningPoker.playerId";
  var POLL_INTERVAL_MS = 1500;

  function clearChildren(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  // ------------------------------------------------------------------
  // Room id: read from URL or generate + persist via replaceState
  // ------------------------------------------------------------------
  function generateRoomId() {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var id = "";
    for (var i = 0; i < 8; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  // Whether this visitor arrived on a bare URL (no ?room=) — i.e. they are
  // CREATING/hosting a new session — vs. following an invite link to JOIN an
  // existing one. Captured before we backfill the room id into the URL.
  var isCreatingSession = false;

  function getOrCreateRoomId() {
    var params = new URLSearchParams(window.location.search);
    var roomId = params.get("room");
    if (!roomId) {
      isCreatingSession = true;
      roomId = generateRoomId();
      params.set("room", roomId);
      var newUrl =
        window.location.pathname + "?" + params.toString() + window.location.hash;
      window.history.replaceState({}, "", newUrl);
    }
    return roomId;
  }

  // ------------------------------------------------------------------
  // Player id: the server has no socket id, so the client owns identity.
  //
  // IMPORTANT: this MUST be per-tab, not per-browser. localStorage is shared
  // across every tab of the same browser, so if the id lived there, opening
  // the app in two tabs would give both the SAME playerId — the second join
  // would overwrite the first player's record (and could steal the host).
  // sessionStorage is scoped to a single tab and survives reloads within it,
  // so each tab (and each device) gets a distinct player. We also key it by
  // roomId so switching rooms in one tab yields a fresh identity.
  // ------------------------------------------------------------------
  function generatePlayerId() {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var id = "";
    for (var i = 0; i < 20; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  function getOrCreatePlayerId(roomIdForKey) {
    var storageKey = PLAYER_ID_STORAGE_KEY + "." + roomIdForKey;
    var id = null;
    try {
      id = window.sessionStorage.getItem(storageKey);
    } catch (e) {
      /* sessionStorage unavailable — ignore */
    }
    if (!id) {
      id = generatePlayerId();
      try {
        window.sessionStorage.setItem(storageKey, id);
      } catch (e) {
        /* ignore */
      }
    }
    return id;
  }

  var roomId = getOrCreateRoomId();
  var playerId = getOrCreatePlayerId(roomId);
  var selfId = playerId;
  var selectedVote = null;
  var latestState = null;
  var pollTimer = null;

  // Remembered join details so a client that gets dropped from the room can
  // silently re-join (see startPolling's self-heal). `hasJoined` gates this so
  // we never re-join before the user has actually joined once.
  var hasJoined = false;
  var joinName = "";
  var joinIsSpectator = false;
  // Avoid firing overlapping re-join requests while one is in flight.
  var rejoinInFlight = false;

  // ------------------------------------------------------------------
  // DOM references
  // ------------------------------------------------------------------
  var joinModal = document.getElementById("join-modal");
  var joinForm = document.getElementById("join-form");
  var nameInput = document.getElementById("name-input");
  var spectatorInput = document.getElementById("spectator-input");
  var modalSubtitle = document.getElementById("modal-subtitle");
  var joinSubmitBtn = document.getElementById("join-submit-btn");

  var appRoot = document.getElementById("app");
  var inviteUrlInput = document.getElementById("invite-url");
  var copyLinkBtn = document.getElementById("copy-link-btn");
  var userNameLabel = document.getElementById("user-name");
  var spectatorTag = document.getElementById("spectator-tag");

  var topicInput = document.getElementById("topic-input");
  var playersGrid = document.getElementById("players-grid");

  var statsSection = document.getElementById("stats-section");
  var statAverage = document.getElementById("stat-average");
  var statMode = document.getElementById("stat-mode");
  var statCount = document.getElementById("stat-count");
  var agreementBadge = document.getElementById("agreement-badge");

  var revealBtn = document.getElementById("reveal-btn");
  var resetBtn = document.getElementById("reset-btn");
  var newRoundBtn = document.getElementById("new-round-btn");
  var hostHint = document.getElementById("host-hint");

  var deckSection = document.getElementById("deck-section");
  var deckEl = document.getElementById("deck");

  var historyList = document.getElementById("history-list");
  var historyEmpty = document.getElementById("history-empty");
  var historyCount = document.getElementById("history-count");
  var clearHistoryBtn = document.getElementById("clear-history-btn");

  var toastContainer = document.getElementById("toast-container");

  // Tracks how many history rounds we've already rendered, so a newly
  // added round can animate in rather than the whole list re-flashing.
  var renderedHistoryCount = 0;

  // ------------------------------------------------------------------
  // Toast helper
  // ------------------------------------------------------------------
  function showToast(message, type) {
    var toast = document.createElement("div");
    toast.className = "toast" + (type === "success" ? " toast-success" : "");
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(function () {
      toast.remove();
    }, 4000);
  }

  // ------------------------------------------------------------------
  // Name prefill from localStorage
  // ------------------------------------------------------------------
  var savedName = "";
  try {
    savedName = window.localStorage.getItem(NAME_STORAGE_KEY) || "";
  } catch (e) {
    /* localStorage unavailable — ignore */
  }
  if (savedName) {
    nameInput.value = savedName;
  }

  // Tailor the start screen to the visitor's role: the person on a bare URL is
  // CREATING (hosting) a new session; anyone following an invite link is
  // JOINING an existing one. The host then shares the invite link so others
  // can join.
  if (modalSubtitle && joinSubmitBtn) {
    if (isCreatingSession) {
      modalSubtitle.textContent =
        "Enter your name to create a session. You'll be the host — share the invite link so others can join.";
      joinSubmitBtn.textContent = "Create session";
    } else {
      modalSubtitle.textContent = "Enter your name to join the estimation session.";
      joinSubmitBtn.textContent = "Join session";
    }
  }

  // ------------------------------------------------------------------
  // HTTP API helpers (replace Socket.IO transport)
  // ------------------------------------------------------------------
  function apiState() {
    return fetch(
      "/api/state?roomId=" + encodeURIComponent(roomId) + "&playerId=" + encodeURIComponent(playerId)
    ).then(function (res) {
      return res.json();
    });
  }

  function apiAction(type, extra) {
    var body = Object.assign({ type: type, roomId: roomId, playerId: playerId }, extra || {});
    return fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (!data.ok && data.error) {
          showToast(data.error);
        }
        if (data.state) {
          latestState = data.state;
          render(data.state);
        }
        return data;
      });
  }

  // ------------------------------------------------------------------
  // Polling (replaces the Socket.IO "state" event stream)
  // ------------------------------------------------------------------
  function startPolling() {
    if (pollTimer) {
      return;
    }
    pollTimer = setInterval(function () {
      apiState()
        .then(function (state) {
          latestState = state;
          render(state);
          maybeRejoin(state);
        })
        .catch(function () {
          /* transient network/error — ignore and try again next tick */
        });
    }, POLL_INTERVAL_MS);
  }

  // ------------------------------------------------------------------
  // Self-heal: if we've joined but the server's player list no longer
  // contains us, silently re-join. This covers two cases the storage fix
  // alone doesn't fully close:
  //   1. A concurrent, non-atomic write on the backend (two devices joining
  //      within ~200ms) that dropped our record on a last-write-wins save.
  //   2. Our room key expiring/being pruned while the tab was idle.
  // Re-joining reinstates our player entry within one poll (~1.5s).
  // ------------------------------------------------------------------
  function maybeRejoin(state) {
    if (!hasJoined || rejoinInFlight) {
      return;
    }
    var players = (state && state.players) || [];
    var present = players.some(function (p) {
      return p.id === selfId;
    });
    if (present) {
      return;
    }
    rejoinInFlight = true;
    apiAction("join", { name: joinName, isSpectator: joinIsSpectator })
      .then(function () {
        rejoinInFlight = false;
      })
      .catch(function () {
        rejoinInFlight = false;
      });
  }

  // Persist the join for this room in sessionStorage so a page REFRESH resumes
  // straight into the room (no modal). sessionStorage is scoped to the tab and
  // cleared when the tab/browser closes, which is exactly the "leave only on
  // close" semantics we want: refresh keeps you in, closing drops you (the
  // server prunes you after STALE_MS since you stop polling).
  var JOIN_STORAGE_KEY = "planningPoker.join." + roomId;

  function saveJoin(name, isSpectator) {
    try {
      window.sessionStorage.setItem(
        JOIN_STORAGE_KEY,
        JSON.stringify({ name: name, isSpectator: isSpectator })
      );
    } catch (e) {
      /* ignore */
    }
  }

  function loadJoin() {
    try {
      var raw = window.sessionStorage.getItem(JOIN_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Enter the room: join on the server, flip from modal to app, start polling.
  function enterRoom(name, isSpectator) {
    return apiAction("join", { name: name, isSpectator: isSpectator }).then(function (data) {
      if (data.ok) {
        selfId = playerId;
        // Remember join details so polling can silently re-join if we ever
        // fall out of the room's player list (see maybeRejoin), and so a
        // refresh can resume without prompting again.
        hasJoined = true;
        joinName = name;
        joinIsSpectator = isSpectator;
        saveJoin(name, isSpectator);
        joinModal.classList.add("hidden");
        appRoot.classList.remove("hidden");
        setupInviteUrl();
        startPolling();
      }
      return data;
    });
  }

  joinForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var name = nameInput.value.trim();
    if (!name) {
      return;
    }
    var isSpectator = spectatorInput.checked;

    try {
      window.localStorage.setItem(NAME_STORAGE_KEY, name);
    } catch (e) {
      /* ignore */
    }

    enterRoom(name, isSpectator);
  });

  // Auto-resume on refresh: if this tab already joined this room, re-enter
  // without showing the modal. (sessionStorage survives reload but not close.)
  var resumed = loadJoin();
  if (resumed && resumed.name) {
    enterRoom(resumed.name, !!resumed.isSpectator);
  }

  // ------------------------------------------------------------------
  // Invite URL + copy
  // ------------------------------------------------------------------
  function setupInviteUrl() {
    var params = new URLSearchParams(window.location.search);
    params.set("room", roomId);
    var url =
      window.location.origin +
      window.location.pathname +
      "?" +
      params.toString();
    inviteUrlInput.value = url;
  }

  copyLinkBtn.addEventListener("click", function () {
    var url = inviteUrlInput.value;
    var fallbackCopy = function () {
      inviteUrlInput.select();
      try {
        document.execCommand("copy");
        showToast("Invite link copied!", "success");
      } catch (e) {
        showToast("Could not copy link.");
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () {
          showToast("Invite link copied!", "success");
        },
        fallbackCopy
      );
    } else {
      fallbackCopy();
    }
  });

  // Name is chosen at join time and shown as a static label in the header
  // (no inline editing).

  // ------------------------------------------------------------------
  // Topic
  // ------------------------------------------------------------------
  function emitTopic() {
    apiAction("setTopic", { topic: topicInput.value });
  }

  topicInput.addEventListener("blur", emitTopic);
  topicInput.addEventListener("change", emitTopic);

  // ------------------------------------------------------------------
  // Deck (voting cards)
  // ------------------------------------------------------------------
  function castVote(value) {
    selectedVote = value;
    apiAction("vote", { value: value });
    highlightSelectedDeckCard();
  }

  function buildDeck() {
    clearChildren(deckEl);
    DECK_VALUES.forEach(function (value, index) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "deck-card";
      btn.textContent = value;
      btn.dataset.value = value;
      // Staggered entrance so the deck "deals" in on load.
      btn.style.animationDelay = index * 0.03 + "s";
      btn.addEventListener("click", function () {
        castVote(value);
      });
      deckEl.appendChild(btn);
    });

    // Custom value entry — type any number/label and press Enter to cast it.
    var custom = document.createElement("form");
    custom.className = "deck-custom";
    custom.setAttribute("aria-label", "Enter a custom card value");

    var input = document.createElement("input");
    input.type = "text";
    input.className = "deck-custom-input";
    input.placeholder = "Custom…";
    input.maxLength = 6;
    input.title = "Type a custom value and press Enter";
    input.setAttribute("aria-label", "Custom card value");

    custom.addEventListener("submit", function (e) {
      e.preventDefault();
      var value = input.value.trim();
      if (!value) return;
      castVote(value);
      input.value = "";
      input.blur();
    });

    custom.appendChild(input);
    deckEl.appendChild(custom);
  }

  function highlightSelectedDeckCard() {
    var cards = deckEl.querySelectorAll(".deck-card");
    var matchedPreset = false;
    cards.forEach(function (card) {
      if (selectedVote !== null && card.dataset.value === selectedVote) {
        card.classList.add("selected");
        matchedPreset = true;
      } else {
        card.classList.remove("selected");
      }
    });

    // If the current vote is a custom value (not one of the preset cards),
    // reflect it on the custom-entry row so the user sees what they cast.
    var customRow = deckEl.querySelector(".deck-custom");
    if (customRow) {
      var isCustom = selectedVote !== null && !matchedPreset;
      customRow.classList.toggle("selected", isCustom);
      var customInput = customRow.querySelector(".deck-custom-input");
      if (customInput) {
        customInput.placeholder = isCustom ? selectedVote : "Custom";
      }
    }
  }

  buildDeck();

  // ------------------------------------------------------------------
  // Reveal / reset
  // ------------------------------------------------------------------
  revealBtn.addEventListener("click", function () {
    apiAction("reveal");
  });

  resetBtn.addEventListener("click", function () {
    // Warn before wiping the current votes (the note is kept — that's the
    // difference from New round).
    if (!window.confirm("Reset the round? This clears everyone's votes so the team can re-vote the same item. The note is kept.")) {
      return;
    }
    selectedVote = null;
    highlightSelectedDeckCard();
    apiAction("reset");
  });

  newRoundBtn.addEventListener("click", function () {
    // Fresh item: clears votes AND the note. Confirm so the note isn't lost by
    // accident (Reset round is the button that keeps it).
    if (!window.confirm("Start a new round? This clears all votes and the note.")) {
      return;
    }
    selectedVote = null;
    highlightSelectedDeckCard();
    apiAction("newRound");
  });

  clearHistoryBtn.addEventListener("click", function () {
    // Destructive and permanent — warn before wiping the whole log.
    if (!window.confirm("Clear the entire round history? This permanently deletes all past rounds and cannot be undone.")) {
      return;
    }
    apiAction("clearHistory");
  });

  // ------------------------------------------------------------------
  // Rendering from `state`
  // ------------------------------------------------------------------
  function render(state) {
    // Topic (avoid clobbering while user is actively typing/focused)
    if (document.activeElement !== topicInput) {
      topicInput.value = state.topic || "";
    }

    var players = state.players || [];
    var self = players.find(function (p) {
      return p.id === selfId;
    });
    var selfIsSpectator = !!(self && self.isSpectator);

    // Sync the welcome name label + spectator tag
    if (self) {
      userNameLabel.textContent = self.name || "Guest";
    }
    spectatorTag.classList.toggle("hidden", !selfIsSpectator);

    // Show/hide the voting deck for spectators
    deckSection.classList.toggle("hidden", selfIsSpectator);

    // Sync selected vote from server state for self (in case of reconnect)
    if (self && !state.revealed) {
      selectedVote = self.hasVoted ? selectedVote : null;
    }
    if (state.revealed && self) {
      selectedVote = self.vote;
    }
    highlightSelectedDeckCard();

    renderPlayers(players, state.revealed, state.hostId);
    renderStats(state.stats, state.revealed);
    renderHistory(state.history || []);

    // Host-only controls: only the host may reveal/reset
    var amHost = !!(state.hostId && state.hostId === selfId);
    revealBtn.classList.toggle("hidden", !amHost);
    // Reset re-opens the current vote, so it only makes sense while cards are
    // still hidden — hide it once the round has been revealed.
    resetBtn.classList.toggle("hidden", !amHost || !!state.revealed);
    newRoundBtn.classList.toggle("hidden", !amHost);
    hostHint.classList.toggle("hidden", amHost);

    // "Clear history" is host-only, and only shown when there's history to clear.
    var hasHistory = (state.history || []).length > 0;
    clearHistoryBtn.classList.toggle("hidden", !amHost || !hasHistory);

    // Reveal button disabled once already revealed
    revealBtn.disabled = !!state.revealed;
    revealBtn.textContent = state.revealed ? "Revealed" : "Reveal cards";
  }

  // Signature of the last rendered player grid. We only rebuild the grid (which
  // re-triggers the card-flip animation) when something actually changed —
  // otherwise every poll would replay the animation, making cards "blink".
  var lastPlayersSignature = null;

  function playersSignature(players, revealed, hostId) {
    return JSON.stringify({
      r: revealed,
      h: hostId,
      p: players.map(function (p) {
        return [p.id, p.name, p.isSpectator, p.hasVoted, revealed ? p.vote : 0];
      }),
    });
  }

  // Initials for the avatar: first letters of the first two words, else the
  // first two characters of the name. Falls back to "?".
  function initialsFor(name) {
    var n = (name || "").trim();
    if (!n) return "?";
    var parts = n.split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return n.slice(0, 2).toUpperCase();
  }

  // Deterministic hue from the name so everyone sees the same colour for a
  // given person (no server state needed).
  function hueFor(name) {
    var s = name || "";
    var hash = 0;
    for (var i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) % 360;
    }
    return hash;
  }

  // Build a circular initials avatar coloured from the player's name.
  function buildAvatar(name) {
    var avatar = document.createElement("div");
    avatar.className = "player-avatar";
    var hue = hueFor(name);
    avatar.style.background =
      "linear-gradient(135deg, hsl(" + hue + ",70%,58%) 0%, hsl(" +
      ((hue + 40) % 360) + ",72%,48%) 100%)";
    avatar.textContent = initialsFor(name);
    return avatar;
  }

  // Build one player's card (avatar + vote face + name + host controls).
  function buildPlayerCard(player, revealed, hostId) {
    var card = document.createElement("div");
    card.className = "player-card";
    if (player.id === selfId) {
      card.classList.add("is-self");
    }
    if (player.isSpectator) {
      card.classList.add("is-spectator");
    }

    card.appendChild(buildAvatar(player.name));

    var face = document.createElement("div");

    if (player.isSpectator) {
      face.className = "player-card-face";
      var eye = document.createElement("span");
      eye.className = "spectator-eye";
      eye.textContent = "👁";
      face.appendChild(eye);
    } else if (revealed) {
      face.className = "vote-card state-revealed";
      face.textContent =
        player.vote !== null && player.vote !== undefined ? player.vote : "-";
    } else if (player.hasVoted) {
      face.className = "vote-card state-hidden";
      face.textContent = "🂠";
    } else {
      face.className = "vote-card state-empty";
      face.textContent = "waiting";
    }

    var name = document.createElement("div");
    name.className = "player-name";
    name.textContent = player.name + (player.id === selfId ? " (you)" : "");

    card.appendChild(face);
    card.appendChild(name);

    if (player.id === hostId) {
      var hostBadge = document.createElement("span");
      hostBadge.className = "host-badge";
      hostBadge.textContent = "Host";
      card.appendChild(hostBadge);
    } else if (hostId === selfId) {
      // Viewer is the host and this is someone else → offer to hand off the
      // host role to them.
      var makeHostBtn = document.createElement("button");
      makeHostBtn.type = "button";
      makeHostBtn.className = "make-host-btn";
      makeHostBtn.textContent = "Make host";
      makeHostBtn.title = "Transfer host to " + player.name;
      (function (targetId, targetName) {
        makeHostBtn.addEventListener("click", function () {
          if (window.confirm("Transfer host to " + targetName + "?")) {
            apiAction("transferHost", { targetId: targetId });
          }
        });
      })(player.id, player.name);
      card.appendChild(makeHostBtn);
    }

    return card;
  }

  function renderPlayers(players, revealed, hostId) {
    var signature = playersSignature(players, revealed, hostId);
    if (signature === lastPlayersSignature) {
      return; // nothing changed — leave the DOM (and animations) alone
    }
    lastPlayersSignature = signature;

    clearChildren(playersGrid);

    players.forEach(function (player) {
      playersGrid.appendChild(buildPlayerCard(player, revealed, hostId));
    });
  }

  function renderStats(stats, revealed) {
    if (!revealed || !stats) {
      statsSection.classList.add("hidden");
      return;
    }
    statsSection.classList.remove("hidden");
    statAverage.textContent =
      stats.average !== null && stats.average !== undefined ? stats.average : "-";
    statMode.textContent =
      stats.mode !== null && stats.mode !== undefined ? stats.mode : "-";
    statCount.textContent =
      stats.count !== null && stats.count !== undefined ? stats.count : "-";
    agreementBadge.classList.toggle("hidden", !stats.agreement);
  }

  // ------------------------------------------------------------------
  // Round history (side panel)
  // ------------------------------------------------------------------
  function renderHistory(history) {
    var hasHistory = history.length > 0;
    historyEmpty.classList.toggle("hidden", hasHistory);
    historyCount.textContent = history.length;

    // Newest round first in the list.
    clearChildren(historyList);

    // Reversed copy so index 0 is the most recent round.
    var reversed = history.slice().reverse();

    reversed.forEach(function (entry, idx) {
      var li = document.createElement("li");
      li.className = "history-item";
      // Only the newest item (which is genuinely new) gets the pop-in
      // animation; older items re-render silently on every state update.
      if (history.length > renderedHistoryCount && idx === 0) {
        li.classList.add("just-added");
      }

      var head = document.createElement("div");
      head.className = "history-item-head";

      var round = document.createElement("span");
      round.className = "history-round";
      round.textContent = "#" + entry.round;

      var avg = document.createElement("span");
      avg.className = "history-avg";
      var avgVal =
        entry.stats && entry.stats.average !== null && entry.stats.average !== undefined
          ? entry.stats.average
          : "–";
      avg.textContent = "avg " + avgVal;
      if (entry.stats && entry.stats.agreement) {
        avg.classList.add("is-agreement");
        avg.textContent = "✔ " + avgVal;
      }

      head.appendChild(round);
      head.appendChild(avg);

      var topic = document.createElement("div");
      topic.className = "history-topic";
      topic.textContent = entry.topic ? entry.topic : "(no topic)";

      var meta = document.createElement("div");
      meta.className = "history-meta";
      var voteCount = entry.stats && entry.stats.count ? entry.stats.count : 0;
      var modeTxt =
        entry.stats && entry.stats.mode !== null && entry.stats.mode !== undefined
          ? " · mode " + entry.stats.mode
          : "";
      meta.textContent = voteCount + (voteCount === 1 ? " vote" : " votes") + modeTxt;

      // Chips showing each individual vote (name: value).
      var chips = document.createElement("div");
      chips.className = "history-chips";
      (entry.votes || []).forEach(function (v) {
        var chip = document.createElement("span");
        chip.className = "history-chip";
        chip.textContent = v.name + ": " + v.vote;
        chips.appendChild(chip);
      });

      li.appendChild(head);
      li.appendChild(topic);
      li.appendChild(meta);
      li.appendChild(chips);
      historyList.appendChild(li);
    });

    renderedHistoryCount = history.length;
  }
})();
