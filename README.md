# AI Topic Checker

Backend for the concentration game. It decides whether a player's word belongs to the round's topic, for example whether "hamburger" counts for "food".

## How it stays fast

1. **Word bank.** When a topic is picked, the server makes one Gemini call that lists about 300 valid answers. It saves the list to `word-banks/<topic>.json`. Checks against the list take about 1 ms.
2. **Referee fallback.** If a word isn't in the bank, the server asks `gemini-3.5-flash-lite` (Google's fastest model) for a plain YES or NO with minimal thinking. A YES adds the word to the bank, and a NO is remembered, so no word goes to Gemini twice.
3. **Timeout.** If Gemini takes longer than 3 s or fails, the word is accepted. A player who answered in time shouldn't lose because of the server.

Banks are saved to disk, so a topic that has been played before is instant after a restart. You can commit `word-banks/` to ship banks for common topics.

## Setup

Requires Node 20 or newer.

```sh
npm install
API_KEY=your-gemini-key npm start
```

| Env var | Default | Notes |
| --- | --- | --- |
| `API_KEY` | (required) | Gemini API key from Google AI Studio |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Any Gemini 3.x Flash or Flash-Lite model |
| `PORT` | `3000` | |

Run the tests with `npm test`. They use a fake Gemini, so they don't need a key.

## API

### `POST /topic`

Call this when the topic is chosen, for example while the round countdown plays. It returns once the word bank is ready (usually a few seconds the first time, and instantly after that).

```json
{ "topic": "food" }
→ { "ready": true, "words": 312, "ms": 4210 }
```

Calling it is optional. `/check` works without it but asks Gemini more often until the bank exists.

### `POST /check`

Call this for every answer.

```json
{ "topic": "food", "word": "Hamburgers" }
→ { "valid": true, "source": "word-bank", "ms": 1 }
```

`source` says where the verdict came from:

| `source` | Meaning |
| --- | --- |
| `word-bank` | Found in the topic's word bank |
| `cache` | Gemini already rejected this word |
| `ai` | Gemini was asked just now |
| `error` | Gemini timed out or failed, so the word was accepted |
| `empty` | The word had no letters or numbers |

### `POST /` (legacy)

The original endpoint: `{ prompt, history }` is sent straight to Gemini and the reply text is returned. It is kept so older game builds keep working. Remove it once the game uses `/check`, because anyone who finds the URL can use it to run prompts on your API key.

## Example: Roblox server script

```lua
local HttpService = game:GetService("HttpService")
local SERVER = "https://your-server.example.com"

local function post(path, body)
	local ok, response = pcall(HttpService.PostAsync, HttpService, SERVER .. path,
		HttpService:JSONEncode(body), Enum.HttpContentType.ApplicationJson)
	return ok and HttpService:JSONDecode(response) or nil
end

-- When the topic is picked (runs while the countdown plays):
task.spawn(post, "/topic", { topic = topic })

-- When a player submits a word, stop their timer first, then check:
local result = post("/check", { topic = topic, word = word })
local valid = result == nil or result.valid -- benefit of the doubt if the server is unreachable
```
