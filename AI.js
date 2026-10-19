const path = require("path");
const express = require("express");
const { GoogleGenAI, ThinkingLevel } = require("@google/genai");
const { createTopicChecker, normalize } = require("./topicChecker");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ✅ Gemini AI setup
// gemini-2.5-flash was retired, and it "thinks" before every answer, which
// made each check slow. Flash-Lite with minimal thinking is Google's fastest model.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const baseConfig = {
  thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
};

async function generate({ prompt, system, schema, timeoutMs }) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      ...baseConfig,
      systemInstruction: system,
      ...(schema && { responseMimeType: "application/json", responseJsonSchema: schema }),
      abortSignal: AbortSignal.timeout(timeoutMs),
    },
  });
  return response.text;
}

const checker = createTopicChecker({
  generate,
  bankDir: path.join(__dirname, "word-banks"),
});

function readText(value, maxLength) {
  return typeof value === "string" && normalize(value) && value.length <= maxLength ? value : null;
}

// Call when a topic is picked (e.g. during the round countdown). It builds a
// word bank so that the checks during the round are instant.
app.post("/topic", async (req, res) => {
  const topic = readText(req.body.topic, 80);
  if (!topic) return res.status(400).json({ error: "Invalid or missing topic." });

  const started = Date.now();
  try {
    const { words } = await checker.prepareTopic(topic);
    res.json({ ready: true, words, ms: Date.now() - started });
  } catch {
    // Checks still work without a bank, they just ask Gemini every time.
    res.status(503).json({ ready: false, ms: Date.now() - started });
  }
});

// Call for every answer. Responds with { valid, source, ms }.
app.post("/check", async (req, res) => {
  const topic = readText(req.body.topic, 80);
  const word = typeof req.body.word === "string" && req.body.word.length <= 50 ? req.body.word : null;
  if (!topic || word === null) {
    return res.status(400).json({ error: "Invalid or missing topic or word." });
  }

  const started = Date.now();
  const result = await checker.check(topic, word);
  console.log(`[Check] ${topic} / ${word} -> ${result.valid} (${result.source}, ${Date.now() - started}ms)`);
  res.json({ ...result, ms: Date.now() - started });
});

// Old endpoint the game used before /topic and /check: sends any prompt
// straight to Gemini. Kept so the current game keeps working; remove it once
// the game uses /check, since anyone can use it to run prompts on your key.
app.post("/", async (req, res) => {
  const { prompt, history } = req.body;

  if (!prompt || typeof prompt !== "string") {
    return res.status(400).send("Invalid or missing prompt.");
  }

  try {
    const chat = ai.chats.create({ model: MODEL, history, config: baseConfig });
    const response = await chat.sendMessage({ message: prompt });
    res.status(200).send(response.text);
  } catch (error) {
    console.error("[Gemini Error]:", error);
    res.status(500).send("Server Error");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT} using ${MODEL}`);
});
