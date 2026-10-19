const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createTopicChecker } = require("../topicChecker");

// Stands in for Gemini: answers word-bank requests with `bank` and referee
// questions with YES for anything in `alsoValid`.
function fakeGemini({ bank = [], alsoValid = [], fail = false } = {}) {
  const calls = { bank: 0, referee: 0 };
  async function generate({ prompt, schema }) {
    if (schema) {
      calls.bank++;
      if (fail) throw new Error("bank failed");
      return JSON.stringify(bank);
    }
    calls.referee++;
    if (fail) throw new Error("referee failed");
    const answer = JSON.parse(prompt.split("\nAnswer: ")[1]);
    return alsoValid.includes(answer.toLowerCase()) ? "YES" : "NO";
  }
  return { generate, calls };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "word-banks-"));
}

test("words in the bank are accepted without asking Gemini again", async () => {
  const gemini = fakeGemini({ bank: ["Pizza", "French Fries", "cherry"] });
  const checker = createTopicChecker({ generate: gemini.generate, bankDir: tempDir() });

  await checker.prepareTopic("Food");
  assert.deepStrictEqual(await checker.check("food", "  PIZZAS! "), { valid: true, source: "word-bank" });
  assert.deepStrictEqual(await checker.check("FOOD", "french fry"), { valid: true, source: "word-bank" });
  assert.deepStrictEqual(await checker.check("food", "Cherries"), { valid: true, source: "word-bank" });
  assert.strictEqual(gemini.calls.referee, 0);
  assert.strictEqual(gemini.calls.bank, 1);
});

test("unknown words go to Gemini once, then come from memory", async () => {
  const gemini = fakeGemini({ bank: ["pizza"], alsoValid: ["hamburger"] });
  const checker = createTopicChecker({ generate: gemini.generate, bankDir: tempDir() });
  await checker.prepareTopic("food");

  assert.deepStrictEqual(await checker.check("food", "Hamburger"), { valid: true, source: "ai" });
  assert.deepStrictEqual(await checker.check("food", "hamburger"), { valid: true, source: "word-bank" });
  assert.deepStrictEqual(await checker.check("food", "fork"), { valid: false, source: "ai" });
  assert.deepStrictEqual(await checker.check("food", "Fork"), { valid: false, source: "cache" });
  assert.strictEqual(gemini.calls.referee, 2);
});

test("checks work before the bank is ready and do not wait for it", async () => {
  let finishBank;
  const checker = createTopicChecker({
    bankDir: tempDir(),
    generate: async ({ schema }) =>
      schema ? new Promise((resolve) => (finishBank = () => resolve('["pizza"]'))) : "YES",
  });

  assert.deepStrictEqual(await checker.check("food", "taco"), { valid: true, source: "ai" });
  finishBank();
  await checker.prepareTopic("food");
  assert.deepStrictEqual(await checker.check("food", "pizza"), { valid: true, source: "word-bank" });
  assert.deepStrictEqual(await checker.check("food", "taco"), { valid: true, source: "word-bank" });
});

test("when Gemini fails the player gets the benefit of the doubt", async () => {
  const gemini = fakeGemini({ fail: true });
  const checker = createTopicChecker({ generate: gemini.generate, bankDir: tempDir() });

  await assert.rejects(checker.prepareTopic("food"));
  assert.deepStrictEqual(await checker.check("food", "fork"), { valid: true, source: "error" });
  assert.deepStrictEqual(await checker.check("food", "fork"), { valid: true, source: "error" });
  assert.deepStrictEqual(await checker.check("food", "?!"), { valid: false, source: "empty" });
  // The failed bank isn't retried on every check.
  assert.strictEqual(gemini.calls.bank, 1);
});

test("word banks are saved to disk and reused after a restart", async () => {
  const bankDir = tempDir();
  const first = fakeGemini({ bank: ["pizza"], alsoValid: ["hamburger"] });
  const checker = createTopicChecker({ generate: first.generate, bankDir });
  await checker.prepareTopic("Fast Food");
  await checker.check("fast food", "hamburger");

  const second = fakeGemini();
  const restarted = createTopicChecker({ generate: second.generate, bankDir });
  assert.deepStrictEqual(await restarted.check("fast food", "pizza"), { valid: true, source: "word-bank" });
  assert.deepStrictEqual(await restarted.check("fast food", "hamburger"), { valid: true, source: "word-bank" });
  assert.deepStrictEqual(second.calls, { bank: 0, referee: 0 });
  assert.deepStrictEqual(fs.readdirSync(bankDir), ["fast-food.json"]);
});

test("topic names can't write outside the bank folder", async () => {
  const bankDir = tempDir();
  const checker = createTopicChecker({ generate: fakeGemini({ bank: ["x"] }).generate, bankDir });
  await checker.prepareTopic("../../etc/passwd");
  assert.deepStrictEqual(fs.readdirSync(bankDir), ["etc-passwd.json"]);
});
