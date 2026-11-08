const assert = require("node:assert/strict");
const test = require("node:test");
const processQueueRouter = require("../routes/processQueue");

test("document verification distinguishes handwritten notebook notes from printed textbook pages", () => {
  const prompt = processQueueRouter.buildDocumentQualityRules(["biology"]);

  assert.match(prompt, /physical paper with clearly visible handwriting/i);
  assert.match(prompt, /handwritten notes remains eligible/i);
  assert.match(prompt, /do not infer that handwritten notes are a printed textbook page/i);
  assert.match(prompt, /only when the submitted page itself is visibly printed or digital/i);
  assert.match(prompt, /Reject .*printed textbook\/book pages or PDFs/i);
});

test("document ratings normalize only valid 0-100 scores and pay proportionally", () => {
  const normalize = processQueueRouter.normalizeDocumentQualityScore;
  const reward = processQueueRouter.calculateDocumentReward;

  assert.equal(normalize(100), 100);
  assert.equal(normalize("74.6"), 75);
  assert.equal(normalize(-1), null);
  assert.equal(normalize(101), null);
  assert.equal(normalize(""), null);
  assert.equal(normalize("not-a-score"), null);
  assert.equal(reward(100, 0), 20);
  assert.equal(reward(75, 0), 15);
  assert.equal(reward(40, 0), 8);
  assert.equal(reward(100, 90), 10);
  assert.equal(reward(100, 100), 0);
});

test("five top-rated document images remain capped at 100 SYNX", () => {
  const reward = processQueueRouter.calculateDocumentReward;
  const batchRewards = [];
  let batchTotal = 0;

  for (let image = 0; image < 6; image++) {
    const imageReward = reward(100, batchTotal);
    batchRewards.push(imageReward);
    batchTotal += imageReward;
  }

  assert.deepEqual(batchRewards, [20, 20, 20, 20, 20, 0]);
  assert.equal(batchTotal, 100);
});
