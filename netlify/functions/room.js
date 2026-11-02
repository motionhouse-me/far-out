// Far Out — room backend.
// Each room is a "meta" blob (written only by the host) plus one blob per player
// (written only by that player), so simultaneous submissions never overwrite each other.
import { getStore } from "@netlify/blobs";

const COLORS = ["#ff6b9d", "#ffd166", "#5ce1e6", "#9b8cff", "#7cf29a", "#ff9f5a", "#f78fff", "#6fb1ff"];
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_PLAYERS = 12;
const PER_ROUND = 7;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const rand32 = () => Math.floor(Math.random() * 2 ** 31);
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

async function newPlayer(store, code, name, colorIndex) {
  const p = {
    id: token().slice(0, 10),
    secret: token(),
    name: clean(name, 16) || "Astronaut",
    color: COLORS[colorIndex % COLORS.length],
    joined: Date.now(),
    rounds: {},
  };
  await store.setJSON(playerKey(code, p.id), p);
  return p;
}

async function auth(store, code, id, secret) {
  if (!id || !secret) return null;
  const p = await store.get(playerKey(code, clean(id, 20)), { type: "json" });
  return p && p.secret === secret ? p : null;
}

export default async (req) => {
  const store = getStore({ name: "far-out-rooms", consistency: "strong" });

  if (req.method === "GET") {
    const code = cleanCode(new URL(req.url).searchParams.get("code"));
    const meta = await store.get(metaKey(code), { type: "json" });
    if (!meta) return json({ error: "Room not found" }, 404);
    const players = await loadPlayers(store, code);
    return json({ meta, players: players.map(publicPlayer) });
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
    const host = await newPlayer(store, code, body.name, 0);
    const meta = { code, hostId: host.id, status: "lobby", round: 0, seeds: [], perRound: PER_ROUND, created: Date.now() };
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
    const p = await newPlayer(store, code, body.name, players.length);
    return json({ code, id: p.id, secret: p.secret });
  }

  const me = await auth(store, code, body.id, body.secret);
  if (!me) return json({ error: "Not in this room" }, 403);

  // ---- host: start a new round (also "play again") ----
  if (action === "start") {
    if (me.id !== meta.hostId) return json({ error: "Only the host can start" }, 403);
    meta.round += 1;
    meta.seeds.push(rand32());
    meta.status = "playing";
    meta.revealed = false;
    meta.startedAt = Date.now();
    await store.setJSON(metaKey(code), meta);
    return json({ ok: true, round: meta.round });
  }

  // ---- host: show results before everyone has finished ----
  if (action === "reveal") {
    if (me.id !== meta.hostId) return json({ error: "Only the host can do that" }, 403);
    meta.revealed = true;
    await store.setJSON(metaKey(code), meta);
    return json({ ok: true });
  }

  // ---- player: submit their answers for the current round ----
  if (action === "submit") {
    const round = Number(body.round);
    if (round !== meta.round) return json({ error: "That round is over" }, 409);
    const answers = Array.isArray(body.answers) ? body.answers.slice(0, PER_ROUND) : [];
    me.rounds[round] = answers.map((a) => clean(a, 40));
    me.finishedAt = Date.now();
    await store.setJSON(playerKey(code, me.id), me);
    return json({ ok: true });
  }

  // ---- player: rename ----
  if (action === "rename") {
    me.name = clean(body.name, 16) || me.name;
    await store.setJSON(playerKey(code, me.id), me);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};

export const config = { path: "/api/room" };
