// Far Out — room backend.
// Each room is a "meta" blob (written by the host) plus one blob per player
// (written by that player), so simultaneous answers never overwrite each other.
// A site-wide "history" blob remembers which prompts were played recently,
// so new rooms keep getting fresh prompts too.
import { getStore } from "@netlify/blobs";

const COLORS = ["#ff6b9d", "#ffd166", "#5ce1e6", "#9b8cff", "#7cf29a", "#ff9f5a", "#f78fff", "#6fb1ff"];
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_PLAYERS = 12;
const PER_ROUND = 7;
const HISTORY_KEY = "global/history";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const token = () => crypto.randomUUID().replace(/-/g, "");
const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanCode = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);

const metaKey = (code) => `${code}/meta`;
const playerKey = (code, id) => `${code}/p/${id}`;

async function loadPlayers(store, code) {
  const { blobs } = await store.list({ prefix: `${code}/p/` });
  const players = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return players.filter(Boolean).sort((a, b) => a.joined - b.joined);
}

const publicPlayer = ({ secret, ...rest }) => rest;

async function newPlayer(store, code, name, existing) {
  const used = new Set(existing.map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[existing.length % COLORS.length];
  const p = {
    id: token().slice(0, 10),
    secret: token(),
    name: clean(name, 16) || "Astronaut",
    color,
    joined: Date.now(),
    rounds: {},
    flags: {},
    vote: null,
  };
  await store.setJSON(playerKey(code, p.id), p);
  return p;
}

async function auth(store, code, id, secret) {
  if (!id || !secret) return null;
  const p = await store.get(playerKey(code, clean(id, 20)), { type: "json" });
  return p && p.secret === secret ? p : null;
}

// Majority of everyone in the room must have voted yes for the next round.
function voteTally(players, nextRound) {
  let yes = 0, no = 0;
  for (const p of players) {
    if (p.vote && p.vote.round === nextRound) p.vote.yes ? yes++ : no++;
  }
  return { yes, no, total: players.length, passed: yes > players.length / 2 };
}

export default async (req) => {
  const store = getStore({ name: "far-out-rooms", consistency: "strong" });

  if (req.method === "GET") {
    const code = cleanCode(new URL(req.url).searchParams.get("code"));
    const meta = await store.get(metaKey(code), { type: "json" });
    if (!meta) return json({ error: "Room not found" }, 404);
    const [players, history] = await Promise.all([
      loadPlayers(store, code),
      store.get(HISTORY_KEY, { type: "json" }),
    ]);
    return json({ meta, players: players.map(publicPlayer), history: history || {} });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const action = body.action;

  // ---- create a room ----
  if (action === "create") {
    let code = "";
    for (let tries = 0; tries < 20; tries++) {
      code = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
      if (!(await store.get(metaKey(code)))) break;
    }
    const host = await newPlayer(store, code, body.name, []);
    const meta = { code, hostId: host.id, status: "lobby", round: 0, picks: {}, perRound: PER_ROUND, totalRounds: 5, gameStart: 1, created: Date.now() };
    await store.setJSON(metaKey(code), meta);
    return json({ code, id: host.id, secret: host.secret });
  }

  const code = cleanCode(body.code);
  const meta = await store.get(metaKey(code), { type: "json" });
  if (!meta) return json({ error: "No room with that code" }, 404);

  // ---- join ----
  if (action === "join") {
    const players = await loadPlayers(store, code);
    if (players.length >= MAX_PLAYERS) return json({ error: "Room is full" }, 409);
    const p = await newPlayer(store, code, body.name, players);
    return json({ code, id: p.id, secret: p.secret });
  }

  const me = await auth(store, code, body.id, body.secret);
  if (!me) return json({ error: "Not in this room" }, 403);
  const isHost = me.id === meta.hostId;

  // ---- vote yes/no on starting the next round ----
  if (action === "vote") {
    me.vote = { round: meta.round + 1, yes: !!body.yes };
    await store.setJSON(playerKey(code, me.id), me);
    return json({ ok: true });
  }

  // ---- host: start a new round (also "next round") ----
  if (action === "start") {
    if (!isHost) return json({ error: "Only the host can start" }, 403);
    if (meta.status === "finished") return json({ error: "This game is over — start a new game" }, 409);
    const played = meta.round - (meta.gameStart || 1) + 1;
    if (played >= (meta.totalRounds || 5)) return json({ error: "That was the last round — reveal the champion!" }, 409);
    const players = await loadPlayers(store, code);
    const tally = voteTally(players, meta.round + 1);
    if (!tally.passed) return json({ error: `Need a majority yes vote first (${tally.yes} of ${tally.total} said yes)` }, 409);
    const picks = Array.isArray(body.picks) ? body.picks.slice(0, PER_ROUND).map((q) => clean(q, 120)) : [];
    if (picks.length !== PER_ROUND) return json({ error: "Couldn't pick prompts — refresh and try again" }, 400);
    meta.round += 1;
    meta.picks = meta.picks || {};
    meta.picks[meta.round] = picks;
    meta.status = "playing";
    meta.revealed = false;
    meta.startedAt = Date.now();
    await store.setJSON(metaKey(code), meta);
    const history = (await store.get(HISTORY_KEY, { type: "json" })) || {};
    const now = Date.now();
    picks.forEach((q) => { history[q] = now; });
    await store.setJSON(HISTORY_KEY, history);
    return json({ ok: true, round: meta.round });
  }

  // ---- host: choose how many rounds this game lasts ----
  if (action === "settings") {
    if (!isHost) return json({ error: "Only the host can change that" }, 403);
    const n = Math.round(Number(body.totalRounds));
    if (!(n >= 1 && n <= 20)) return json({ error: "Pick between 1 and 20 rounds" }, 400);
    const played = Math.max(0, meta.round - (meta.gameStart || 1) + 1);
    meta.totalRounds = Math.max(n, played || 1);
    await store.setJSON(metaKey(code), meta);
    return json({ ok: true });
  }

  // ---- host: end the game and show the champion ----
  if (action === "finish") {
    if (!isHost) return json({ error: "Only the host can do that" }, 403);
    if (meta.round < (meta.gameStart || 1)) return json({ error: "Play at least one round first" }, 409);
    meta.status = "finished";
    meta.finalRound = meta.round;
    meta.revealed = true;
    await store.setJSON(metaKey(code), meta);
    return json({ ok: true });
  }

  // ---- host: same room, brand new game ----
  if (action === "newgame") {
    if (!isHost) return json({ error: "Only the host can do that" }, 403);
    meta.status = "lobby";
    meta.gameStart = meta.round + 1;
    delete meta.finalRound;
    meta.revealed = false;
    await store.setJSON(metaKey(code), meta);
    return json({ ok: true });
  }

  // ---- player: tap 😂 on an answer (feeds the end-of-game hall of fame) ----
  if (action === "laugh") {
    const key = clean(body.key, 40);
    if (!/^\d+:\d:[a-z0-9]+$/.test(key)) return json({ error: "Bad answer reference" }, 400);
    const set = new Set(me.laughs || []);
    body.on ? set.add(key) : set.delete(key);
    me.laughs = [...set].slice(-500);
    await store.setJSON(playerKey(code, me.id), me);
    return json({ ok: true });
  }

  // ---- host: show results before everyone has finished ----
  if (action === "reveal") {
    if (!isHost) return json({ error: "Only the host can do that" }, 403);
    meta.revealed = true;
    await store.setJSON(metaKey(code), meta);
    return json({ ok: true });
  }

  // ---- host: remove a player ----
  if (action === "kick") {
    if (!isHost) return json({ error: "Only the host can remove players" }, 403);
    const target = clean(body.target, 20);
    if (!target || target === me.id) return json({ error: "You can't remove yourself" }, 400);
    await store.delete(playerKey(code, target));
    return json({ ok: true });
  }

  // ---- player: leave the room (removes them; passes host on if needed) ----
  if (action === "leave") {
    await store.delete(playerKey(code, me.id));
    if (isHost) {
      const rest = await loadPlayers(store, code);
      if (rest.length) {
        meta.hostId = rest[0].id;
        await store.setJSON(metaKey(code), meta);
      }
    }
    return json({ ok: true });
  }

  // ---- player: submit their answers for the current round ----
  if (action === "submit") {
    const round = Number(body.round);
    if (round !== meta.round) return json({ error: "That round is over" }, 409);
    const answers = Array.isArray(body.answers) ? body.answers.slice(0, PER_ROUND) : [];
    const flags = Array.isArray(body.flags) ? body.flags.map(Number).filter((n) => n >= 0 && n < PER_ROUND) : [];
    me.rounds[round] = answers.map((a) => clean(a, 40));
    me.flags = me.flags || {};
    me.flags[round] = { left: [...new Set(flags)], ejected: !!body.ejected };
    me.finishedAt = Date.now();
    await store.setJSON(playerKey(code, me.id), me);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};

export const config = { path: "/api/room" };
