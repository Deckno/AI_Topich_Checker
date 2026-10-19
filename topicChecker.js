const fs = require("fs");
const path = require("path");

// Prompts for the model. The game never sends prompts itself, so players
// can only ever put a short word into them.
const REFEREE_RULES =
  "You are the referee of a party word game. A player must name something " +
  "that belongs to the topic. Accept specific examples, brand names, plurals " +
  "and common misspellings. Reject words that are only loosely related " +
  "(for the topic food, \"pizza\" is YES but \"fork\" is NO). " +
  "Reply with only YES or NO.";

const WORD_LIST_SCHEMA = { type: "array", items: { type: "string" } };

// "  Piñas! " -> "pinas", so lookups ignore case, accents and punctuation.
function normalize(text) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The word in singular and plural forms: "cherries" <-> "cherry", "boxes" <-> "box".
function variants(word) {
  const forms = [word, word + "s", word + "es"];
  if (word.endsWith("y")) forms.push(word.slice(0, -1) + "ies");
  if (word.endsWith("ies")) forms.push(word.slice(0, -3) + "y");
  if (word.endsWith("es")) forms.push(word.slice(0, -2));
  if (word.endsWith("s")) forms.push(word.slice(0, -1));
  return forms;
}

function createTopicChecker({
  generate,
  bankDir,
  bankSize = 300,
  checkTimeoutMs = 3000,
  bankTimeoutMs = 30000,
  retryAfterMs = 60000,
}) {
  const topics = new Map();

  function bankFile(key) {
    const slug = key.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60);
    return path.join(bankDir, `${slug || "topic"}.json`);
  }

  function saveBank(topic) {
    fs.mkdirSync(bankDir, { recursive: true });
    const data = { topic: topic.name, words: [...topic.bank].sort() };
    fs.writeFileSync(bankFile(topic.key), JSON.stringify(data, null, 2));
  }

  // One model call that lists lots of valid answers, so almost every later
  // check is a local lookup instead of a round trip to Gemini.
  async function buildBank(topic) {
    const text = await generate({
      prompt:
        `List ${bankSize} different answers that belong to the topic ` +
        `${JSON.stringify(topic.name)} in a party word game. Start with the ` +
        `most common answers, then less obvious ones. Use short names of one ` +
        `to three words, with no duplicates.`,
      schema: WORD_LIST_SCHEMA,
      timeoutMs: bankTimeoutMs,
    });
    const words = JSON.parse(text);
    if (!Array.isArray(words)) throw new Error("Word bank is not a list");
    for (const word of words) {
      if (typeof word === "string" && normalize(word)) topic.bank.add(normalize(word));
    }
    topic.ready = true;
    saveBank(topic);
  }

  function prepare(topic) {
    if (topic.ready) return Promise.resolve();
    if (!topic.building && Date.now() - topic.failedAt > retryAfterMs) {
      topic.building = buildBank(topic)
        .catch((error) => {
          topic.failedAt = Date.now();
          console.error(`[Word bank failed] ${topic.name}:`, error.message);
          throw error;
        })
        .finally(() => {
          topic.building = null;
        });
      // Checks don't wait for the bank, so don't let a failure go unhandled.
      topic.building.catch(() => {});
    }
    return topic.building || Promise.reject(new Error("Word bank recently failed"));
  }

  function getTopic(name) {
    const key = normalize(name);
    if (!topics.has(key)) {
      const topic = { key, name: name.trim(), bank: new Set(), rejected: new Set(), ready: false, building: null, failedAt: 0 };
      try {
        const saved = JSON.parse(fs.readFileSync(bankFile(key), "utf8"));
        saved.words.forEach((word) => topic.bank.add(word));
        topic.ready = true;
      } catch {
        // No saved bank yet; it gets built on first use.
      }
      topics.set(key, topic);
    }
    return topics.get(key);
  }

  async function askReferee(topic, word) {
    const text = await generate({
      system: REFEREE_RULES,
      prompt: `Topic: ${JSON.stringify(topic.name)}\nAnswer: ${JSON.stringify(word)}`,
      timeoutMs: checkTimeoutMs,
    });
    return /^\W*yes/i.test(text);
  }

  return {
    // Builds the word bank for a topic. Call it when the topic is chosen.
    async prepareTopic(name) {
      const topic = getTopic(name);
      await prepare(topic);
      return { words: topic.bank.size };
    },

    async check(name, rawWord) {
      const topic = getTopic(name);
      const word = normalize(rawWord);
      if (!topic.ready) prepare(topic).catch(() => {});
      if (!word) return { valid: false, source: "empty" };

      if (variants(word).some((form) => topic.bank.has(form))) {
        return { valid: true, source: "word-bank" };
      }
      if (topic.rejected.has(word)) {
        return { valid: false, source: "cache" };
      }

      try {
        const valid = await askReferee(topic, rawWord.trim());
        if (valid) {
          topic.bank.add(word);
          if (topic.ready) saveBank(topic);
        } else {
          topic.rejected.add(word);
        }
        return { valid, source: "ai" };
      } catch (error) {
        // A player who answered in time shouldn't lose because Gemini was
        // slow or down, so give them the benefit of the doubt.
        console.error(`[Check failed] ${topic.name} / ${rawWord}:`, error.message);
        return { valid: true, source: "error" };
      }
    },
  };
}

module.exports = { createTopicChecker, normalize };
