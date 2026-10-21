# Discord TTS Bot

A Discord bot that speaks for you in voice chat. DM it a message and it reads the text aloud in whatever voice channel you're in, using [ElevenLabs](https://elevenlabs.io) text-to-speech, including a clone of your own voice.

I built it so I can keep taking part in calls when I can't talk out loud. Typing a DM is quick, and everyone in the call hears it in my voice.

## Features

- **DM to speak.** Send the bot a direct message and it plays the speech in your current voice channel. No commands in the server and no virtual microphone needed.
- **Voice cloning.** Works with any ElevenLabs voice, including a cloned one, so the bot sounds like you.
- **Emotion tags.** Write `[laughs]`, `[whispers]`, `[sarcastic]` and other tags in a message. Tagged messages switch to the expressive `eleven_v3` model automatically; plain messages use the faster, cheaper `eleven_flash_v2_5`.
- **Ordered queue with prefetching.** Audio is requested from ElevenLabs as soon as a DM arrives, but clips always play in the order they were sent. This keeps the delay short when you send several messages quickly.
- **Follows you around.** The bot moves with you when you switch channels and leaves when you leave voice.
- **Recovers from dropped connections.** A failed voice connection is retried once and rebuilt on the next message, so a network blip doesn't need a restart.
- **Cleans up text before speaking.** Mentions become display names, custom emoji become their names, links become "link", and Markdown symbols are stripped.
- **Owner only.** The bot only takes DMs from the configured owner, so nobody else can spend your ElevenLabs credits.

## Commands

DM these to the bot. Each one also works with `!` in place of `/`.

| Command | What it does |
| --- | --- |
| `/join` | Join the voice channel you're in |
| `/leave` | Leave the call and clear the queue |
| `/skip` | Stop the current clip and clear the queue |
| `/voices` | List the voices on your ElevenLabs account |
| `/voice <id>` | Switch voice until the bot restarts |
| `/tags` | Show the available emotion tags |
| `/help` | Show the command list |

Any other DM is spoken aloud, for example `[whispers] don't tell anyone [laughs]`.

## Tech stack

- **Node.js** (ES modules)
- **[discord.js](https://discord.js.org) v14** for the gateway, DMs and voice-state events
- **[@discordjs/voice](https://github.com/discordjs/voice)** for voice connections and audio playback, with `ffmpeg-static` and `opusscript` for encoding
- **ElevenLabs REST API** for text-to-speech and listing voices

## How it works

1. The bot listens for DMs from the owner. It needs the `DirectMessages` intent and the `Channel` partial, because DM channels aren't cached.
2. When you `/join`, it finds the voice channel you're in across all of its servers, checks that it has Connect and Speak permission there, and joins (self-deafened). It only stays in one call at a time.
3. Each DM is cleaned up and sent to the ElevenLabs text-to-speech endpoint right away. The pending request goes into a FIFO queue.
4. A single worker goes through the queue in order. It waits for each clip's audio, plays it through a shared audio player, and waits for playback to finish before starting the next one. The bot reacts 🔊 to a message once it starts speaking it, and replies with the error if a clip fails.
5. Voice-state events keep the connection in sync with you: it moves when you change channel and leaves when you leave voice.

## Setup

**Requirements:** Node.js 20.6 or newer (for `--env-file`), a Discord bot application, and an ElevenLabs account.

1. **Create the Discord bot.** In the [Discord Developer Portal](https://discord.com/developers/applications), create an application, add a bot, and copy its token. Invite it to your server with the `bot` scope and the **View Channel**, **Connect** and **Speak** permissions.
2. **Get an ElevenLabs API key** from elevenlabs.io → Developers → API Keys.
3. **Install and configure:**

   ```sh
   git clone https://github.com/howardtep/discord-tts-bot.git
   cd discord-tts-bot
   npm install
   cp .env.example .env
   ```

   Fill in `.env`:

   | Variable | Required | Description |
   | --- | --- | --- |
   | `DISCORD_TOKEN` | Yes | Bot token from the Developer Portal |
   | `OWNER_ID` | Yes | Your Discord user ID (Developer Mode → right-click yourself → Copy User ID) |
   | `ELEVENLABS_API_KEY` | Yes | ElevenLabs API key |
   | `VOICE_ID` | No | ElevenLabs voice to use. Defaults to the stock voice "George" |
   | `ELEVENLABS_MODEL` | No | Model for plain messages. Defaults to `eleven_flash_v2_5` |
   | `ELEVENLABS_TAG_MODEL` | No | Model for messages with tags. Defaults to `eleven_v3` |
   | `DEBUG` | No | Set to any value to log voice-connection debug output |

4. **Run it:**

   ```sh
   npm start
   ```

5. Join a voice channel, DM the bot `/join`, then DM it anything you want said.

## Using your own voice

Voice cloning needs a paid ElevenLabs plan (Starter or above). Clone your voice on elevenlabs.io, DM the bot `/voices` to find the new voice's ID, and put that ID in `.env` as `VOICE_ID`.
