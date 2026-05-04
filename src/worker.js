// ===== Constants =====
const PHASES = {
  LOBBY: "lobby",
  COUNTDOWN: "countdown",
  OBSERVATION: "observation",
  DECISION: "decision",
  REVEAL: "reveal",
};
const COUNTDOWN_MS = 10_000;
const OBSERVATION_MS = 30_000;
const MAX_PLAYERS = 8;
const GRACE_MS = 15_000; // keep a disconnected player around this long for reconnect

const SUITS = [
  { sym: "♠", color: "black" },
  { sym: "♥", color: "red" },
  { sym: "♦", color: "red" },
  { sym: "♣", color: "black" },
];
const RANKS = [
  { v: 2, label: "2" }, { v: 3, label: "3" }, { v: 4, label: "4" },
  { v: 5, label: "5" }, { v: 6, label: "6" }, { v: 7, label: "7" },
  { v: 8, label: "8" }, { v: 9, label: "9" }, { v: 10, label: "10" },
  { v: 11, label: "J" }, { v: 12, label: "Q" }, { v: 13, label: "K" },
  { v: 14, label: "A" },
];

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ ...r, suit: s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ===== Worker entry =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(room)) {
        return new Response("Invalid room code", { status: 400 });
      }
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// ===== GameRoom Durable Object =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map(); // sessionId -> { ws, playerId }
    this.players = new Map(); // playerId -> { name, card, decision, drinkCount }
    this.phase = PHASES.LOBBY;
    this.hostId = null;
    this.phaseEndAt = null;
    this.timer = null;
    this.lastResult = null;
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 20);
    const clientId = (url.searchParams.get("clientId") || "").trim();
    // Validation rejections stay as HTTP — these are programmer errors, not
    // user-facing room conditions, and the client never recovers from them.
    if (!name) return new Response("Missing name", { status: 400 });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) {
      return new Response("Missing or invalid clientId", { status: 400 });
    }

    const existing = this.players.get(clientId);

    // Decide acceptance up front so we can reject via a WebSocket close code.
    // HTTP 4xx upgrade failures surface to the browser as opaque close 1006,
    // which our reconnecting client can't distinguish from a network blip —
    // it would loop trying to rejoin a full / locked room forever.
    let rejectCode = 0; // 0 = accept
    let rejectReason = "";
    if (!existing) {
      if (this.players.size >= MAX_PLAYERS) {
        rejectCode = 4030; rejectReason = "Room full";
      } else if (this.phase !== PHASES.LOBBY && this.phase !== PHASES.REVEAL) {
        // LOBBY and REVEAL are between-round states where new players can join.
        rejectCode = 4023; rejectReason = "Game in progress";
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (rejectCode) {
      try { server.close(rejectCode, rejectReason); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    if (existing) {
      // Reconnect / takeover: reuse the seat (preserves card / decision /
      // drinkCount). Cancel pending grace removal if any.
      if (existing.removeTimer) {
        clearTimeout(existing.removeTimer);
        existing.removeTimer = null;
      }
      existing.name = name; // allow renaming on reconnect
    } else {
      this.players.set(clientId, {
        name,
        card: null,
        decision: null,
        drinkCount: 0,
        removeTimer: null,
      });
      if (!this.hostId) this.hostId = clientId;
    }

    // Capture (but don't yet close) the prior session. Register the new
    // session FIRST so the prior socket's close handler — which may fire
    // synchronously from close() — sees `sess.ws !== server` and skips
    // handleDisconnect.
    const prior = existing ? this.sessions.get(clientId) : null;
    this.sessions.set(clientId, { ws: server, playerId: clientId });

    server.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      await this.handleMessage(clientId, msg);
    });
    const onClose = () => {
      // Ignore close events from sockets that were already replaced by a
      // newer connection for the same clientId.
      const sess = this.sessions.get(clientId);
      if (sess && sess.ws === server) {
        this.handleDisconnect(clientId);
      }
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    if (prior) {
      try { prior.ws.close(4002, "Replaced by new connection"); } catch {}
    }

    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(playerId, msg) {
    switch (msg.type) {
      case "ping": {
        // Liveness probe — keeps the client's heartbeat happy during quiet
        // periods (lobby, observation) and makes silent-dead sockets fail fast.
        const sess = this.sessions.get(playerId);
        if (sess) {
          try { sess.ws.send(JSON.stringify({ type: "pong" })); } catch {}
        }
        break;
      }
      case "hello": {
        // Client requests fresh state — used after (re)connect to make sure
        // the client renders against current server state even if the
        // initial broadcast in fetch() was missed for any reason.
        const session = this.sessions.get(playerId);
        if (session) {
          try {
            session.ws.send(JSON.stringify(this.viewForPlayer(playerId)));
          } catch (e) {}
        }
        break;
      }
      case "start":
        if (playerId === this.hostId && this.phase === PHASES.LOBBY) {
          if (this.players.size < 2) return;
          this.startCountdown();
        }
        break;
      case "decision":
        if (this.phase === PHASES.DECISION && (msg.choice === "fight" || msg.choice === "fold")) {
          const p = this.players.get(playerId);
          if (p && !p.decision) {
            p.decision = msg.choice;
            this.broadcast();
            if ([...this.players.values()].every(pl => pl.decision)) {
              this.endDecision();
            }
          }
        }
        break;
      case "next":
        if (playerId === this.hostId && this.phase === PHASES.REVEAL) {
          this.resetToLobby();
        }
        break;
    }
  }

  handleDisconnect(clientId) {
    this.sessions.delete(clientId);
    const player = this.players.get(clientId);
    if (!player) return;

    // In LOBBY, drop immediately — no game state worth preserving
    if (this.phase === PHASES.LOBBY) {
      this.removePlayer(clientId);
      this.broadcast();
      return;
    }

    // In active game, hold the seat for GRACE_MS so the client can reconnect
    if (player.removeTimer) clearTimeout(player.removeTimer);
    player.removeTimer = setTimeout(() => {
      player.removeTimer = null;
      // If they reconnected during the grace period, bail out
      if (this.sessions.has(clientId)) return;
      this.removePlayer(clientId);
      if (this.players.size === 0) {
        this.clearTimer();
        this.phase = PHASES.LOBBY;
        this.lastResult = null;
        return;
      }
      if (this.players.size < 2 && this.phase !== PHASES.LOBBY) {
        this.resetToLobby();
        return;
      }
      // If we were waiting on this player to decide, check completion
      if (this.phase === PHASES.DECISION
          && [...this.players.values()].every(pl => pl.decision)) {
        this.endDecision();
        return;
      }
      this.broadcast();
    }, GRACE_MS);
    this.broadcast();
  }

  removePlayer(clientId) {
    this.players.delete(clientId);
    if (this.hostId === clientId) {
      this.hostId = this.players.keys().next().value || null;
    }
  }

  startCountdown() {
    this.phase = PHASES.COUNTDOWN;
    this.phaseEndAt = Date.now() + COUNTDOWN_MS;
    this.lastResult = null;
    for (const p of this.players.values()) {
      p.card = null;
      p.decision = null;
    }
    this.clearTimer();
    this.timer = setTimeout(() => this.startObservation(), COUNTDOWN_MS);
    this.broadcast();
  }

  startObservation() {
    this.phase = PHASES.OBSERVATION;
    this.phaseEndAt = Date.now() + OBSERVATION_MS;
    const deck = buildDeck();
    for (const p of this.players.values()) p.card = deck.pop();
    this.clearTimer();
    this.timer = setTimeout(() => this.startDecision(), OBSERVATION_MS);
    this.broadcast();
  }

  startDecision() {
    this.phase = PHASES.DECISION;
    this.phaseEndAt = null;
    this.clearTimer();
    this.broadcast();
  }

  endDecision() {
    this.phase = PHASES.REVEAL;
    this.phaseEndAt = null;
    this.clearTimer();

    const fighters = [...this.players.entries()].filter(([, p]) => p.decision === "fight");
    const folders = [...this.players.entries()].filter(([, p]) => p.decision === "fold");
    const fightCount = fighters.length;

    if (fighters.length > 0) {
      // Highest = winners (display only), Lowest = losers (drink)
      let topV = -Infinity, lowV = Infinity;
      for (const [, p] of fighters) {
        if (p.card.v > topV) topV = p.card.v;
        if (p.card.v < lowV) lowV = p.card.v;
      }
      const winners = fighters.filter(([, p]) => p.card.v === topV).map(([id]) => id);
      // Only one fighter = solo, no opponent to lose to
      const losers = fightCount > 1
        ? fighters.filter(([, p]) => p.card.v === lowV).map(([id]) => id)
        : [];
      const loserSet = new Set(losers);
      const drinks = {};
      for (const [id, p] of fighters) {
        if (loserSet.has(id)) {
          drinks[id] = fightCount;
          p.drinkCount += fightCount;
        } else {
          drinks[id] = 0;
        }
      }
      for (const [id, p] of folders) {
        drinks[id] = 1;
        p.drinkCount += 1;
      }
      this.lastResult = {
        fighters: fighters.map(([id]) => id),
        folders: folders.map(([id]) => id),
        winners,
        losers,
        drinks,
        fightCount,
      };
    } else {
      // All folded — everyone drinks 1
      const drinks = {};
      for (const [id, p] of folders) {
        drinks[id] = 1;
        p.drinkCount += 1;
      }
      this.lastResult = {
        fighters: [],
        folders: folders.map(([id]) => id),
        winners: [],
        losers: [],
        drinks,
        fightCount: 0,
      };
    }
    this.broadcast();
  }

  resetToLobby() {
    this.phase = PHASES.LOBBY;
    this.phaseEndAt = null;
    this.clearTimer();
    for (const p of this.players.values()) {
      p.card = null;
      p.decision = null;
    }
    this.lastResult = null;
    this.broadcast();
  }

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  broadcast() {
    for (const [, session] of this.sessions) {
      try {
        const msg = this.viewForPlayer(session.playerId);
        session.ws.send(JSON.stringify(msg));
      } catch (e) {
        // ignore broken sockets
      }
    }
  }

  viewForPlayer(playerId) {
    const me = this.players.get(playerId);
    const players = [...this.players.entries()].map(([id, p]) => {
      const isYou = id === playerId;
      // Cards visible only at REVEAL; OWN card during OBSERVATION is sent separately as `myCard`
      let card = null;
      if (this.phase === PHASES.REVEAL) card = p.card;
      return {
        id,
        name: p.name,
        drinkCount: p.drinkCount,
        decision: this.phase === PHASES.REVEAL ? p.decision : null,
        decided: !!p.decision,
        card,
        isYou,
      };
    });
    return {
      type: "state",
      state: {
        phase: this.phase,
        players,
        hostId: this.hostId,
        you: playerId,
        phaseEndAt: this.phaseEndAt,
        // Your phone displays YOUR card during observation (for others to see when on forehead)
        myCard: (this.phase === PHASES.OBSERVATION && me) ? me.card : null,
        result: this.phase === PHASES.REVEAL ? this.lastResult : null,
      },
    };
  }
}
