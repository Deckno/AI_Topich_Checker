const express = require("express");
const bodyParser = require("body-parser");

// ✅ Load node-fetch and polyfill global fetch
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
globalThis.fetch = fetch;

const { GoogleGenerativeAI } = require("@google/generative-ai");
const app = express();
const PORT = 3000;
app.use(bodyParser.json());

// ✅ Gemini AI setup
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

// Correct config object
const generationConfig = {
  temperature: 0,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 2048,
};

async function run(prompt, history = []) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: "You are a strict topic validator for a fast-paced game. Rules: - You receive a topic and a player’s answer. - If the player’s answer EXACTLY and SPECIFICALLY matches the given topic, respond with ONLY yes. - If the answer is vague, unrelated, or incorrect in any way, respond with ONLY no. - Never provide explanations, reasoning, or additional text — only return one word: yes or no. - Do not allow partial matches, overly broad answers, or category-like answers. Only accept exact, specific matches. - If unsure, always respond with no"
    });

    const chat = model.startChat({
      generationConfig,
      history,
    });

    const result = await chat.sendMessage(prompt);
    const text = await result.response.text();

    console.log("[Gemini Response]:", text);
    return { success: true, text };
  } catch (error) {
    console.error("[Gemini Error]:", error);
    return { success: false };
  }
}

app.post("/", async (req, res) => {
  const { prompt, history } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).send("Invalid or missing prompt.");
  }

  const result = await run(prompt, history);

  if (result.success) {
    res.status(200).send(result.text);
  } else {
    res.status(500).send("Server Error");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
