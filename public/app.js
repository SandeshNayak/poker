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

  // Emoji reactions everyone can send. Must stay in sync with the server-side
  // ALLOWED_REACTIONS allow-list in lib/store.js.
  var REACTION_EMOJIS = ["👍", "👎", "🎉", "😂", "🤔", "❤️", "🔥", "👏", "😮", "🚀"];

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
  var SET_SELECTED_KEY = "planningPoker.vote." + roomId;
  // Restore the last card this tab picked, so a REFRESH mid-round keeps the
  // deck highlighted (the server keeps the vote itself, but hides its value
  // until reveal — see render's sync below). sessionStorage is per-tab, so each
  // browser tab keeps its own selection.
  try {
    selectedVote = window.sessionStorage.getItem(SET_SELECTED_KEY) || null;
  } catch (e) {
    /* ignore */
  }

  // Single place that owns selectedVote so the persisted copy always matches the
  // live value (cast, reset/new-round and the render sync all go through this).
  function storeSelectedVote(value) {
    selectedVote = value;
    try {
      if (value === null || value === undefined || value === "") {
        window.sessionStorage.removeItem(SET_SELECTED_KEY);
      } else {
        window.sessionStorage.setItem(SET_SELECTED_KEY, value);
      }
    } catch (e) {
      /* ignore */
    }
  }

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
  var rosterCount = document.getElementById("roster-count");

  var chatWidget = document.getElementById("chat-widget");
  var chatPanel = document.getElementById("chat-panel");
  var chatList = document.getElementById("chat-list");
  var chatEmpty = document.getElementById("chat-empty");
  var chatForm = document.getElementById("chat-form");
  var chatInput = document.getElementById("chat-input");
  var chatLauncher = document.getElementById("chat-launcher");
  var chatCloseBtn = document.getElementById("chat-close-btn");
  var chatUnread = document.getElementById("chat-unread");

  var statsSection = document.getElementById("stats-section");
  var statAverage = document.getElementById("stat-average");
  var statMode = document.getElementById("stat-mode");
  var statCount = document.getElementById("stat-count");
  var agreementBadge = document.getElementById("agreement-badge");

  var revealBtn = document.getElementById("reveal-btn");
  var resetBtn = document.getElementById("reset-btn");
  var newRoundBtn = document.getElementById("new-round-btn");
  var hostHint = document.getElementById("host-hint");

  var deckGroup = document.getElementById("deck-group");
  var dockDivider = document.getElementById("dock-divider");
  var deckEl = document.getElementById("deck");
  var pokerTable = document.querySelector(".poker-table");

  var historyList = document.getElementById("history-list");
  var historyEmpty = document.getElementById("history-empty");
  var historyCount = document.getElementById("history-count");
  var clearHistoryBtn = document.getElementById("clear-history-btn");

  var toastContainer = document.getElementById("toast-container");

  var reactionBar = document.getElementById("reaction-bar");
  var reactionLayer = document.getElementById("reaction-layer");

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
    // Guard against double-click / rapid-fire votes within the same poll cycle.
    if (window.__ppLastVoteTs) {
      var now = Date.now();
      if (now - window.__ppLastVoteTs < 1000) return; // ignore within 1s
    }
    window.__ppLastVoteTs = Date.now();
    storeSelectedVote(value);
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
  // Emoji reactions
  //
  // Sending a reaction is a normal action; the server stores it briefly and
  // every client's poll picks it up (see renderReactions). We animate each
  // reaction id exactly once — including our own — so what everyone sees is
  // driven purely by shared state, keeping all clients consistent.
  // ------------------------------------------------------------------
  function sendReaction(emoji) {
    apiAction("react", { emoji: emoji });
  }

  function buildReactionBar() {
    if (!reactionBar) return;
    clearChildren(reactionBar);
    REACTION_EMOJIS.forEach(function (emoji) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "reaction-btn";
      btn.textContent = emoji;
      btn.setAttribute("aria-label", "React with " + emoji);
      btn.title = "React " + emoji;
      btn.addEventListener("click", function () {
        sendReaction(emoji);
      });
      reactionBar.appendChild(btn);
    });
  }

  // Reactions already floated, so a reaction seen across multiple polls only
  // animates once. Kept bounded so it can't grow without limit in a long session.
  var seenReactionIds = Object.create(null);
  var seenReactionOrder = [];

  function markReactionSeen(id) {
    seenReactionIds[id] = true;
    seenReactionOrder.push(id);
    if (seenReactionOrder.length > 200) {
      var old = seenReactionOrder.shift();
      delete seenReactionIds[old];
    }
  }

  function floatReaction(reaction) {
    if (!reactionLayer) return;
    var el = document.createElement("div");
    el.className = "reaction-float";
    // Random horizontal lane + slight drift/scale variation so a burst of the
    // same emoji doesn't stack into a single column.
    var lane = 8 + Math.random() * 84; // vw
    var drift = (Math.random() * 2 - 1) * 40; // px
    var delay = Math.random() * 0.15; // s
    el.style.left = lane + "vw";
    el.style.setProperty("--drift", drift + "px");
    el.style.animationDelay = delay + "s";

    var glyph = document.createElement("span");
    glyph.className = "reaction-float-glyph";
    glyph.textContent = reaction.emoji;
    el.appendChild(glyph);

    if (reaction.by) {
      var who = document.createElement("span");
      who.className = "reaction-float-who";
      who.textContent = reaction.by;
      el.appendChild(who);
    }

    el.addEventListener("animationend", function () {
      el.remove();
    });
    reactionLayer.appendChild(el);
  }

  function renderReactions(reactions) {
    if (!reactionLayer || !reactions || !reactions.length) return;
    reactions.forEach(function (reaction) {
      if (!reaction || !reaction.id || seenReactionIds[reaction.id]) return;
      markReactionSeen(reaction.id);
      floatReaction(reaction);
    });
  }

  buildReactionBar();

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
    storeSelectedVote(null);
    highlightSelectedDeckCard();
    apiAction("reset");
  });

  newRoundBtn.addEventListener("click", function () {
    // Fresh item: clears votes AND the note. Confirm so the note isn't lost by
    // accident (Reset round is the button that keeps it).
    if (!window.confirm("Start a new round? This clears all votes and the note.")) {
      return;
    }
    storeSelectedVote(null);
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

  // Animation state — so one-shot effects (deal, flip, burst, settle,
  // count-up, nudge) fire on the poll where the state flips, never on every
  // 1.5s poll (which would replay them and make the UI "blink").
  var lastRevealed = false;
  var lastAllVoted = false;
  var lastStatsKey = null;
  var knownPlayerIds = {};
  var votedPlayerIds = {};
  var burstEmojis = ["🎉", "✨", "🎊", "⭐", "🥳", "🍀"];

  // Agreement burst — a confetti pop rising from the table centre.
  function fireBurst() {
    if (!reactionLayer) return;
    for (var i = 0; i < 16; i++) {
      (function (i) {
        setTimeout(function () {
          var el = document.createElement("div");
          el.className = "reaction-float reaction-burst";
          el.style.left = 26 + Math.random() * 48 + "vw";
          el.style.setProperty("--drift", (Math.random() * 2 - 1) * 90 + "px");
          el.style.animationDelay = Math.random() * 0.25 + "s";
          var glyph = document.createElement("span");
          glyph.className = "reaction-float-glyph";
          glyph.textContent =
            burstEmojis[Math.floor(Math.random() * burstEmojis.length)];
          el.appendChild(glyph);
          el.addEventListener("animationend", function () {
            el.remove();
          });
          reactionLayer.appendChild(el);
        }, i * 24);
      })(i);
    }
  }

  // Round reset / new round: a one-shot felt "sweep" across the table.
  function triggerTableSettle() {
    if (!pokerTable) return;
    pokerTable.classList.add("is-settling");
    setTimeout(function () {
      pokerTable.classList.remove("is-settling");
    }, 700);
  }

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

    // Spectators can't pick a card, so hide the card-picking group (and its
    // divider) — but keep the reaction bar in the same dock, since spectators
    // are allowed to react.
    if (deckGroup) deckGroup.classList.toggle("hidden", selfIsSpectator);
    if (dockDivider) dockDivider.classList.toggle("hidden", selfIsSpectator);

    // Keep the selected card in sync. The server HIDES vote values until the
    // reveal (self.vote is null mid-round exactly so results stay secret), so
    // we never restore the highlight from self.vote while cards are down.
    // Instead we hold the selection locally — persisted in sessionStorage by
    // storeSelectedVote — so it survives a refresh; we only clear it once this
    // player actually has no vote in the current round.
    if (self && !state.revealed) {
      // Only clear selectedVote if the user hasn't voted yet (selectedVote is null).
      // If they already voted, preserve the local selection so the deck card stays highlighted
      // until the round resets. The server has the authoritative vote state, and we don't
      // want to wipe the UI highlight based on a hasVoted flag that may lag on the first poll.
      if (selectedVote === null) {
        storeSelectedVote(null);
      }
    }
    if (state.revealed && self) {
      selectedVote = self.vote;
    }
    highlightSelectedDeckCard();

    renderRoster(players, state.revealed);
    renderPlayers(players, state.revealed, state.hostId);
    renderStats(state.stats, state.revealed);
    renderHistory(state.history || []);
    renderReactions(state.reactions || []);
    renderChat(state.chat || []);

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

    // ---- animations (fire only on the poll where the state flips) ----
    var allVoted = false;
    var nonSpectators = players.filter(function (p) {
      return !p.isSpectator;
    });
    if (nonSpectators.length > 0) {
      allVoted = nonSpectators.every(function (p) {
        return p.hasVoted;
      });
    }

    // Reveal button glows once every voter has cast but cards are still down.
    revealBtn.classList.toggle("is-ready", amHost && allVoted && !state.revealed);

    // Nudge the host the moment the last vote lands.
    if (allVoted && !lastAllVoted && !state.revealed) {
      showToast(
        amHost
          ? "Everyone has voted — hit Reveal cards! 🃏"
          : "Everyone has voted. Waiting for the host to reveal…",
        "success"
      );
    }
    lastAllVoted = allVoted;

    // Reveal: agreement confetti burst.
    if (state.revealed && !lastRevealed) {
      if (state.stats && state.stats.agreement) {
        fireBurst();
      }
    }
    // Round reset / new round: felt sweep.
    if (!state.revealed && lastRevealed) {
      triggerTableSettle();
    }
    lastRevealed = !!state.revealed;
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
    // Vivid dual-tone gradient — a wider hue sweep reads as more playful/colorful.
    avatar.style.background =
      "linear-gradient(135deg, hsl(" + hue + ",85%,62%) 0%, hsl(" +
      ((hue + 70) % 360) + ",80%,50%) 100%)";
    avatar.textContent = initialsFor(name);
    return avatar;
  }

  // Build one player's card (avatar + vote face + name + host controls).
  function buildPlayerCard(player, revealed, hostId, index, isNew, justVoted) {
    var card = document.createElement("div");
    card.className = "player-card";
    if (isNew) {
      card.classList.add("deal-in");
    }
    if (player.id === selfId) {
      card.classList.add("is-self");
    }
    if (player.isSpectator) {
      card.classList.add("is-spectator");
    }

    var avatar = buildAvatar(player.name);
    // Happy bounce the moment a player's vote lands.
    if (justVoted) {
      avatar.classList.add("just-voted");
    }
    card.appendChild(avatar);

    // Compact vote indicator (a small chip) instead of a full-size card face,
    // so many seats fit without overflowing into the deck. State is conveyed by
    // the chip + a ring on the card: 👁 spectator, ✓ voted (hidden), the value
    // on reveal, and a faint empty chip while still deciding.
    var face = document.createElement("div");
    face.className = "vote-chip";

    if (player.isSpectator) {
      face.classList.add("is-eye");
      face.textContent = "👁";
    } else if (revealed) {
      face.classList.add("is-value");
      face.textContent =
        player.vote !== null && player.vote !== undefined ? player.vote : "–";
      // Staggered 3D flip as the votes come up (only for actual votes).
      if (player.hasVoted) {
        face.classList.add("flip-in");
        face.style.animationDelay = Math.min(index, 12) * 55 + "ms";
      }
    } else if (player.hasVoted) {
      card.classList.add("is-voted");
      face.classList.add("is-back");
    } else {
      card.classList.add("is-waiting");
      face.classList.add("is-idle");
      face.textContent = "";
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

    players.forEach(function (player, idx) {
      var isNew = !knownPlayerIds[player.id];
      if (isNew) knownPlayerIds[player.id] = true;
      var justVoted = !votedPlayerIds[player.id] && player.hasVoted;
      if (player.hasVoted) votedPlayerIds[player.id] = true;
      playersGrid.appendChild(
        buildPlayerCard(player, revealed, hostId, idx, isNew, justVoted)
      );
    });
  }

  // ------------------------------------------------------------------
  // Voted-count chip (left panel header)
  //
  // The left panel is now a live chat; the "N ✓" chip keeps the at-a-glance
  // voting progress that the old roster used to convey.
  // ------------------------------------------------------------------
  function renderRoster(players, revealed) {
    if (!rosterCount) return;
    var votedNum = players.filter(function (p) {
      return !p.isSpectator && p.hasVoted;
    }).length;
    var voters = players.filter(function (p) {
      return !p.isSpectator;
    }).length;
    rosterCount.textContent = votedNum + "/" + voters + " ✓";
  }

  // ------------------------------------------------------------------
  // Live chat (left panel)
  //
  // Messages ride the same polling model as reactions: `chat` action stores a
  // message in room state, and each poll appends any messages we haven't shown
  // yet (tracked by id) so we don't re-render the whole log every 1.5s.
  // ------------------------------------------------------------------
  var seenChatIds = Object.create(null);
  var chatInitialized = false;

  function formatChatTime(at) {
    if (!at) return "";
    try {
      return new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (e) {
      return "";
    }
  }

  function appendChatMessage(msg) {
    if (!chatList) return;
    var li = document.createElement("li");
    li.className = "chat-msg is-new";
    if (msg.byId === selfId) li.classList.add("is-self");

    // Head row mirrors .history-item-head: label on the left, value on the
    // right (sender name · timestamp).
    var head = document.createElement("div");
    head.className = "chat-msg-head";
    var left = document.createElement("span");
    left.className = "chat-msg-left";
    left.appendChild(buildAvatar(msg.by));
    var who = document.createElement("span");
    who.className = "chat-msg-who";
    who.textContent = msg.byId === selfId ? "You" : msg.by;
    left.appendChild(who);
    head.appendChild(left);
    var when = document.createElement("span");
    when.className = "chat-msg-time";
    when.textContent = formatChatTime(msg.at);
    head.appendChild(when);
    li.appendChild(head);

    var body = document.createElement("div");
    body.className = "chat-msg-text";
    body.textContent = msg.text; // textContent → no HTML injection
    li.appendChild(body);

    // Newest-first: put each new message at the top of the list.
    chatList.insertBefore(li, chatList.firstChild);
  }

  function renderChat(chat) {
    if (!chatList) return;
    var fresh = [];
    for (var i = 0; i < chat.length; i++) {
      var m = chat[i];
      if (m && m.id && !seenChatIds[m.id]) {
        seenChatIds[m.id] = true;
        fresh.push(m);
      }
    }
    if (!fresh.length) {
      if (!chatInitialized && chatEmpty) {
        chatEmpty.classList.toggle("hidden", chat.length > 0);
      }
      // A completed poll (even an empty one) establishes the baseline, so the
      // first message to arrive afterwards counts as unread.
      chatInitialized = true;
      return;
    }
    if (chatEmpty) chatEmpty.classList.add("hidden");

    // Newest messages are inserted at the top. Was the user already scrolled to
    // (near) the top? If so, keep them pinned to the newest message; otherwise
    // leave their scroll position alone so they can read older messages.
    var nearTop = chatList.scrollTop < 60;

    fresh.forEach(appendChatMessage);

    // If the window is closed and a fresh message arrives from someone else,
    // pop it open automatically (Messenger-style). Skip the very first render
    // (existing backlog) and the user's own messages.
    if (chatInitialized && !chatIsOpen()) {
      var others = fresh.filter(function (m) {
        return m.byId !== selfId;
      }).length;
      if (others > 0) {
        // Auto-open, but don't persist — respects the user's saved preference
        // on the next reload.
        setChatOpen(true, false);
      }
    }

    chatInitialized = true;

    if (nearTop) chatList.scrollTop = 0;
  }

  function sendChat() {
    if (!chatInput) return;
    var text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    apiAction("chat", { text: text });
  }

  if (chatForm) {
    chatForm.addEventListener("submit", function (e) {
      e.preventDefault();
      sendChat();
    });
  }

  // Open/close the floating chat window (Messenger-style). Closed by default;
  // the launcher bubble stays visible and shows an unread badge. The choice
  // persists across reloads.
  var chatUnreadCount = 0;

  function refreshChatUnreadBadge() {
    if (!chatUnread) return;
    chatUnread.textContent = chatUnreadCount > 99 ? "99+" : String(chatUnreadCount);
    chatUnread.classList.toggle("hidden", chatUnreadCount <= 0);
  }

  function chatIsOpen() {
    return !!chatWidget && !chatWidget.classList.contains("is-closed");
  }

  // persist defaults to true; auto-open (on an incoming message) passes false
  // so it doesn't overwrite the user's own open/closed preference.
  function setChatOpen(open, persist) {
    if (!chatWidget) return;
    chatWidget.classList.toggle("is-closed", !open);
    if (chatLauncher) {
      chatLauncher.setAttribute("aria-expanded", open ? "true" : "false");
      chatLauncher.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    }
    if (open) {
      // Opening clears unread and pins to the newest message.
      chatUnreadCount = 0;
      refreshChatUnreadBadge();
      if (chatList) chatList.scrollTop = 0;
      if (chatInput) chatInput.focus();
    }
    if (persist === false) return;
    try {
      localStorage.setItem("pp-chat-open", open ? "1" : "0");
    } catch (e) {
      /* localStorage may be unavailable (private mode); ignore. */
    }
  }

  if (chatWidget) {
    // Closed by default; only open if the user previously chose to.
    var startOpen = false;
    try {
      startOpen = localStorage.getItem("pp-chat-open") === "1";
    } catch (e) {
      /* ignore */
    }
    setChatOpen(startOpen);
  }

  if (chatLauncher) {
    chatLauncher.addEventListener("click", function () {
      setChatOpen(!chatIsOpen());
    });
  }
  if (chatCloseBtn) {
    chatCloseBtn.addEventListener("click", function () {
      setChatOpen(false);
    });
  }

  function renderStats(stats, revealed) {
    if (!revealed || !stats) {
      statsSection.classList.add("hidden");
      lastStatsKey = null;
      return;
    }
    statsSection.classList.remove("hidden");
    var key =
      String(stats.average) + "|" + String(stats.mode) + "|" + String(stats.count);
    if (key !== lastStatsKey) {
      lastStatsKey = key;
      animateNumber(statAverage, stats.average, 700);
      animateNumber(statMode, stats.mode, 700);
    }
    statCount.textContent =
      stats.count !== null && stats.count !== undefined ? stats.count : "-";
    agreementBadge.classList.toggle("hidden", !stats.agreement);
  }

  // Count-up helper for the revealed stats — runs once per reveal, then the
  // numbers sit still until the next round.
  function animateNumber(el, target, duration) {
    if (!el) return;
    var num = Number(target);
    if (isNaN(num)) {
      el.textContent =
        target === null || target === undefined ? "-" : String(target);
      return;
    }
    var decimals = Math.round(num) === num ? 0 : 1;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      var val = num * eased;
      el.textContent =
        decimals === 0 ? String(Math.round(val)) : val.toFixed(decimals);
      if (p < 1) {
        requestAnimationFrame(step);
      }
    }
    requestAnimationFrame(step);
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
