import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  evaluateAttempt,
  evaluatePublish,
  evaluateRating,
  organizerScore,
  playerSnapshot,
  rankPlayers,
  solvedPrefixCount,
} from "../src/lib/podchody-core.mjs";

const checkpoints = [
  { id: 11, position: 1, hint: "Szukaj przy fontannie", answerCode: "FONT1", lat: 53.4285, lng: 14.5528, imageUrl: null },
  { id: 12, position: 2, hint: "Drugi punkt przy moście", answerCode: "MOST2", lat: 53.431, lng: 14.56, imageUrl: "data:image/jpeg;base64,QQ==" },
  { id: 13, position: 3, hint: "Finał pod kasztanowcem", answerCode: "FINA3", lat: 53.42, lng: 14.54, imageUrl: null },
];

test("a wrong checkpoint code is rejected and then rate limited without revealing the next point", () => {
  const now = 1_700_000_000_000;
  let wrongAttempts = 0;
  let windowStartedAt = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const decision = evaluateAttempt({
      checkpoints,
      solvedCount: 0,
      answer: "ZLYKOD",
      wrongAttempts,
      windowStartedAt,
      now,
    });
    assert.equal(decision.status, 400);
    assert.equal(decision.correct, false);
    assert.equal(decision.solvedCount, 0);
    wrongAttempts = decision.wrongAttempts;
    windowStartedAt = decision.windowStartedAt;
  }

  const limited = evaluateAttempt({
    checkpoints,
    solvedCount: 0,
    answer: "ZLYKOD",
    wrongAttempts,
    windowStartedAt,
    now,
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.correct, false);
  assert.ok(limited.retryAfterSeconds > 0);
  const lockedCorrect = evaluateAttempt({
    checkpoints,
    solvedCount: 0,
    answer: "FONT1",
    wrongAttempts: limited.wrongAttempts,
    windowStartedAt: limited.windowStartedAt,
    now,
  });
  assert.equal(lockedCorrect.status, 429);
  assert.equal(lockedCorrect.solvedCount, 0);

  const afterWindow = evaluateAttempt({
    checkpoints,
    solvedCount: 0,
    answer: "MOST2",
    wrongAttempts: limited.wrongAttempts,
    windowStartedAt: limited.windowStartedAt,
    now: now + 10 * 60 * 1000,
  });
  assert.equal(afterWindow.status, 400, "a future checkpoint code does not skip ahead");
  assert.equal(afterWindow.solvedCount, 0);
});

test("the player view exposes only the current checkpoint and hides its exact coordinates", () => {
  const view = playerSnapshot(checkpoints, 0);
  assert.equal(view.current.position, 1);
  assert.equal(view.current.hint, "Szukaj przy fontannie");
  assert.notEqual(view.current.area.lat, checkpoints[0].lat);
  assert.notEqual(view.current.area.lng, checkpoints[0].lng);
  assert.equal(view.finished, false);
  const encoded = JSON.stringify(view);
  assert.equal(encoded.includes("MOST2"), false);
  assert.equal(encoded.includes("FINA3"), false);
  assert.equal(encoded.includes("FONT1"), false);
  assert.equal(encoded.includes("Drugi punkt przy moście"), false);
  assert.equal(encoded.includes("answerCode"), false);
  assert.equal(view.current.imageUrl, null);

  const advanced = evaluateAttempt({
    checkpoints,
    solvedCount: 0,
    answer: "font1",
    wrongAttempts: 0,
    windowStartedAt: null,
    now: Date.now(),
  });
  assert.equal(advanced.correct, true);
  assert.equal(advanced.solvedCount, 1);
  const next = playerSnapshot(checkpoints, advanced.solvedCount);
  assert.equal(next.current.hint, "Drugi punkt przy moście");
  assert.equal(JSON.stringify(next).includes("FINA3"), false);
  assert.equal(JSON.stringify(next).includes("Finał pod kasztanowcem"), false);
});

test("skipped progress does not unlock a later checkpoint", () => {
  assert.equal(solvedPrefixCount(checkpoints, new Set([12, 13])), 0);
  assert.equal(solvedPrefixCount(checkpoints, new Set([11, 12])), 2);
});

test("a player can rate the organizer once, and only after finishing", () => {
  const early = evaluateRating({ finished: false, existingValue: null, value: 1 });
  assert.equal(early.ok, false);
  assert.equal(early.status, 409);

  const up = evaluateRating({ finished: true, existingValue: null, value: 1 });
  const down = evaluateRating({ finished: true, existingValue: null, value: -1 });
  assert.deepEqual(up, { ok: true, value: 1 });
  assert.deepEqual(down, { ok: true, value: -1 });

  const again = evaluateRating({ finished: true, existingValue: up.value, value: -1 });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(organizerScore([1, 1, -1, 0]), 1);
});

test("publishing with no pins is rejected and a paid pin is charged only for creators", () => {
  const empty = evaluatePublish({ pinBalance: 0, hasUnlimitedPins: false, checkpointCount: 3 });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 402);
  assert.deepEqual(evaluatePublish({ pinBalance: 1, hasUnlimitedPins: false, checkpointCount: 3 }), { ok: true, charge: true });
  assert.deepEqual(evaluatePublish({ pinBalance: 0, hasUnlimitedPins: true, checkpointCount: 3 }), { ok: true, charge: false });
  assert.equal(evaluatePublish({ pinBalance: 4, hasUnlimitedPins: false, checkpointCount: 1 }).status, 400);
});

test("ranking prefers finished players by total time", () => {
  const ranking = rankPlayers([
    { nickname: "Ala", teamName: "Wilki", solvedCount: 1, joinedAt: "2026-01-01T10:00:00.000Z", finishedAt: null },
    { nickname: "Bartek", teamName: null, solvedCount: 3, joinedAt: "2026-01-01T10:00:00.000Z", finishedAt: "2026-01-01T11:00:00.000Z" },
    { nickname: "Celina", teamName: "Wilki", solvedCount: 3, joinedAt: "2026-01-01T10:00:00.000Z", finishedAt: "2026-01-01T10:30:00.000Z" },
  ]);
  assert.deepEqual(ranking.map((row) => row.nickname), ["Celina", "Bartek", "Ala"]);
  assert.equal(ranking[0].durationMs, 30 * 60 * 1000);
  assert.equal(ranking[2].finished, false);
});

test("the game route builds the player response from the snapshot and gates publishing", async () => {
  const source = await readFile(new URL("../src/routes/games.ts", import.meta.url), "utf8");
  assert.match(source, /playerSnapshot\(/);
  assert.match(source, /evaluateAttempt\(/);
  assert.match(source, /evaluateRating\(/);
  assert.match(source, /evaluatePublish\(/);
  assert.match(source, /status\(outcome\.status\)/);
  assert.doesNotMatch(source, /answerCode:\s*current/);
  const payments = await readFile(new URL("../src/routes/payments.ts", import.meta.url), "utf8");
  assert.match(payments, /mode: "payment"/);
  assert.match(payments, /getCreatorPinPackage/);
});
