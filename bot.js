// DM the bot and it speaks the message in your current voice channel, using ElevenLabs TTS.
import { Readable } from "node:stream";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import {
  joinVoiceChannel, getVoiceConnection, entersState, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
} from "@discordjs/voice";

const { DISCORD_TOKEN, OWNER_ID, ELEVENLABS_API_KEY } = process.env;
let voiceId = process.env.VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // ElevenLabs stock voice "George"
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5"; // fastest model, half the credits per character
// Audio tags like [laughs] or [whispers] only work on v3, so tagged messages switch to it.
const TAG_MODEL = process.env.ELEVENLABS_TAG_MODEL || "eleven_v3";
const hasTags = text => /\[[a-z][a-z ]*\]/i.test(text);
const MAX_CHARS = 600;

const missing = ["DISCORD_TOKEN", "OWNER_ID", "ELEVENLABS_API_KEY"].filter(k => !process.env[k]);
if (missing.length) { console.error(`Missing in .env: ${missing.join(", ")}`); process.exit(1); }

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel], // DM channels aren't cached, so DMs arrive as partials
});
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

/* ---------- ElevenLabs ---------- */
async function eleven(path, init = {}) {
  const res = await fetch("https://api.elevenlabs.io" + path, {
    ...init, headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    let detail = await res.text();
    try { const j = JSON.parse(detail).detail; detail = j?.message || j?.status || (typeof j === "string" ? j : detail); } catch {}
    throw new Error(`ElevenLabs ${res.status}: ${String(detail).slice(0, 300)}`);
  }
  return res;
}
async function speech(text) {
  const res = await eleven(`/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST", body: JSON.stringify({ text, model_id: hasTags(text) ? TAG_MODEL : MODEL }),
  });
  return Buffer.from(await res.arrayBuffer());
}

/* ---------- voice ---------- */
// The guild + voice channel the owner is in right now, if any.
function ownerChannel() {
  for (const g of client.guilds.cache.values()) {
    const ch = g.voiceStates.cache.get(OWNER_ID)?.channel;
    if (ch) return ch;
  }
  return null;
}
async function connectTo(channel) {
  if (!channel.joinable || !channel.permissionsFor(channel.guild.members.me)?.has("Speak"))
    throw new Error(`I'm not allowed in #${channel.name}. Give me View Channel, Connect and Speak there.`);
  // Only one call at a time: leave any other server first.
  for (const g of client.guilds.cache.values())
    if (g.id !== channel.guild.id) getVoiceConnection(g.id)?.destroy();
  let conn = getVoiceConnection(channel.guild.id);
  if (!conn || conn.joinConfig.channelId !== channel.id || conn.state.status === VoiceConnectionStatus.Destroyed) {
    conn = joinVoiceChannel({
      channelId: channel.id, guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true,
    });
    conn.on("stateChange", (a, b) => console.log(`[voice] ${a.status} -> ${b.status}`));
    if (process.env.DEBUG) conn.on("debug", m => console.log("[voice debug]", m));
    // A failed connection (e.g. a DNS blip) is dropped so the next message starts fresh.
    conn.on("error", err => { console.error("[voice error]", err.message); if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy(); });
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      // Moved between channels reconnects by itself; anything else (kicked, channel deleted) ends the connection.
      try {
        await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
      } catch { if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy(); }
    });
  }
  try { await entersState(conn, VoiceConnectionStatus.Ready, 20000); }
  catch { throw new Error(`couldn't connect to voice (stuck at "${conn.state.status}")`); }
  conn.subscribe(player);
}

/* ---------- queue ---------- */
// Audio is fetched as soon as a DM arrives, then played strictly in order.
const queue = [];
let running = false, joined = false; // joined: /join was used and /leave hasn't been since
// Connect, with one retry to cover brief network hiccups.
function join(channel) {
  return connectTo(channel).catch(err => {
    if (err.message.startsWith("I'm not allowed")) throw err;
    console.error("Retrying voice connection:", err.message);
    getVoiceConnection(channel.guild.id)?.destroy();
    return connectTo(channel);
  });
}
function enqueue(msg, text) {
  queue.push({ msg, audio: speech(text) });
  queue.at(-1).audio.catch(() => {}); // handled when its turn comes
  if (!running) run();
}
async function run() {
  running = true;
  while (queue.length) {
    const { msg, audio } = queue.shift();
    try {
      const channel = ownerChannel();
      if (!joined || !channel) { await msg.reply("I'm not in a call anymore, so I skipped that one.").catch(() => {}); continue; }
      await join(channel); // reconnects if the connection dropped
      const buf = await audio;
      player.play(createAudioResource(Readable.from(buf)));
      msg.react("🔊").catch(() => {});
      await entersState(player, AudioPlayerStatus.Playing, 10000).catch(() => { throw new Error("audio never started playing"); });
      await entersState(player, AudioPlayerStatus.Idle, 120000);
    } catch (err) {
      console.error(err);
      await msg.reply(`Couldn't say that: ${err.message}`).catch(() => {});
    }
  }
  running = false;
}

/* ---------- text cleanup ---------- */
function speakable(msg) {
  return msg.content
    .replace(/<a?:(\w+):\d+>/g, "$1")                                   // custom emoji -> its name
    .replace(/<@!?(\d+)>/g, (_, id) => client.users.cache.get(id)?.displayName || "someone")
    .replace(/<#\d+>|<@&\d+>/g, "")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/[*_~`|>]/g, "")
    .trim()
    .slice(0, MAX_CHARS);
}

/* ---------- DMs ---------- */
const HELP = [
  "`/join` join your voice channel, then DM me anything and I'll say it there.",
  "`/leave` leave the call · `/skip` stop talking and clear the queue",
  "`/voices` list your ElevenLabs voices · `/voice <id>` switch voice",
  "`/tags` emotion tags like `[laughs]` or `[whispers]` you can put in messages",
  "Commands work with `!` too, e.g. `!join`.",
].join("\n");
const TAGS = [
  "Put tags in square brackets anywhere in a message, e.g. `[whispers] don't tell anyone [laughs]`.",
  "Tagged messages use the v3 model: more expressive, a little slower, double the credits.",
  "**Vocalization** `[laughs]` `[chuckles]` `[sighs]` `[gasps]` `[exhales]` `[clears throat]` `[crying]`",
  "**Delivery** `[whispers]` `[shouts]` `[slowly]` `[quickly]` `[pause]` `[short pause]`",
  "**Emotion** `[excited]` `[sarcastic]` `[curious]` `[nervous]` `[angry]` `[sad]` `[happy]` `[tired]`",
  "**Character** `[pirate voice]` `[british accent]` `[robotic]` `[dramatically]` `[deadpan]`",
  "Tags are suggestions to the model, so some voices follow them better than others.",
].join("\n");
function leave() {
  joined = false; queue.length = 0; player.stop(true);
  for (const g of client.guilds.cache.values()) getVoiceConnection(g.id)?.destroy();
}

client.on(Events.MessageCreate, async msg => {
  if (msg.guild || msg.author.bot || msg.author.id !== OWNER_ID) return;
  // Commands start with / or ! (with no registered slash commands, Discord sends "/join" as plain text).
  const [, name = "", arg = ""] = /^[!/](\w+)\s*(.*)$/s.exec(msg.content.trim()) || [];
  const cmd = name.toLowerCase();

  if (cmd === "help") return msg.reply(HELP);
  if (cmd === "tags") return msg.reply(TAGS);
  if (cmd === "join") {
    const channel = ownerChannel();
    if (!channel) return msg.reply("Join a voice channel in a server I'm in first.");
    try { await join(channel); joined = true; return msg.react("✅"); }
    catch (err) { console.error(err); return msg.reply(`Couldn't join: ${err.message}`); }
  }
  if (cmd === "leave") { leave(); return msg.react("👋"); }
  if (cmd === "skip") { queue.length = 0; player.stop(true); return msg.react("⏭️"); }
  if (cmd === "voices") {
    try {
      const { voices } = await (await eleven("/v1/voices")).json();
      const lines = voices.map(v => `${v.voice_id === voiceId ? "▶" : "•"} **${v.name}** \`${v.voice_id}\``);
      return msg.reply(lines.join("\n").slice(0, 1900) || "No voices found.");
    } catch (err) { return msg.reply(err.message); }
  }
  if (cmd === "voice" && arg) {
    voiceId = arg.split(/\s+/)[0];
    return msg.reply(`Voice set to \`${voiceId}\` until I restart. Put it in .env as VOICE_ID to keep it.`);
  }

  const text = speakable(msg);
  if (!text) return;
  if (!joined) return msg.reply("I'm not in a call. DM `/join` first.");
  enqueue(msg, text);
});

// Leave when the owner leaves voice; follow them if they move channels in the same server.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.id !== OWNER_ID) return;
  if (!newState.channelId) return leave();
  const conn = getVoiceConnection(oldState.guild.id);
  if (!conn) return;
  else if (newState.channelId !== conn.joinConfig.channelId) connectTo(newState.channel).catch(console.error);
});

player.on("error", err => console.error("Player error:", err.message));
client.once(Events.ClientReady, c => console.log(`Logged in as ${c.user.tag}. DM me to talk.`));
client.login(DISCORD_TOKEN);
