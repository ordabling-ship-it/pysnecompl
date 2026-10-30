import { createHash, randomBytes } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  gameCheckpointsTable,
  gamePlayersTable,
  gameProgressTable,
  gameRatingsTable,
  gamesTable,
  usersTable,
} from "@workspace/db";
import { getRoleCapabilities } from "@workspace/api-zod";
import { requireAdmin, type AdminUser } from "../lib/admin-session";
import { recordAudit } from "../lib/audit";
import { genCode } from "../lib/codes";
import { isAllowedImageUrl } from "../lib/images";
import { createAttemptWindow } from "../lib/attempt-limit.mjs";
import {
  ATTEMPT_WINDOW_MS,
  evaluateAttempt,
  evaluatePublish,
  evaluateRating,
  normalizeJoinCode,
  normalizeNickname,
  normalizeTeamName,
  organizerScore,
  playerSnapshot,
  rankPlayers,
  solvedPrefixCount,
  validateGameDraft,
  type AttemptDecision,
} from "../lib/podchody-core.mjs";

const router: IRouter = Router();
const PLAYER_COOKIE = "pysne_player";
const joinAttempts = createAttemptWindow({ limit: 20, windowMs: 10 * 60 * 1000 });
const checkpointAttempts = new Map<string, { wrongAttempts: number; windowStartedAt: number | null }>();

function playerCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 180 * 24 * 60 * 60 * 1000,
  };
}

function hashGuestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readGuestHash(req: Request): string | null {
  const token = req.cookies?.[PLAYER_COOKIE];
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  return hashGuestToken(token);
}

function ensureGuestHash(req: Request, res: Response): string {
  const existing = req.cookies?.[PLAYER_COOKIE];
  if (typeof existing === "string" && existing.length >= 20 && existing.length <= 200) {
    return hashGuestToken(existing);
  }
  const token = randomBytes(32).toString("base64url");
  res.cookie(PLAYER_COOKIE, token, playerCookieOptions());
  return hashGuestToken(token);
}

function optionalGameId(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

function rememberAttempt(key: string, decision: AttemptDecision): void {
  if (decision.correct) {
    checkpointAttempts.delete(key);
    return;
  }
  checkpointAttempts.set(key, {
    wrongAttempts: decision.wrongAttempts,
    windowStartedAt: decision.windowStartedAt,
  });
  if (checkpointAttempts.size <= 10000) return;
  const now = Date.now();
  for (const [savedKey, value] of checkpointAttempts) {
    if (value.windowStartedAt == null || now - value.windowStartedAt > ATTEMPT_WINDOW_MS) checkpointAttempts.delete(savedKey);
  }
}

async function findPlayer(guestHash: string, gameId?: number) {
  const filters = [eq(gamePlayersTable.guestHash, guestHash)];
  if (gameId) filters.push(eq(gamePlayersTable.gameId, gameId));
  const [player] = await db.select().from(gamePlayersTable)
    .where(and(...filters))
    .orderBy(desc(gamePlayersTable.lastSeenAt))
    .limit(1);
  return player ?? null;
}

async function loadRanking(gameId: number) {
  const players = await db.select({
    nickname: gamePlayersTable.nickname,
    teamName: gamePlayersTable.teamName,
    joinedAt: gamePlayersTable.joinedAt,
    finishedAt: gamePlayersTable.finishedAt,
    solvedCount: sql<number>`(select count(*)::int from game_progress where game_progress.player_id = ${gamePlayersTable.id})`,
  }).from(gamePlayersTable).where(eq(gamePlayersTable.gameId, gameId));
  return rankPlayers(players);
}

async function buildPlayerSession(playerId: number) {
  const [player] = await db.select().from(gamePlayersTable).where(eq(gamePlayersTable.id, playerId)).limit(1);
  if (!player) return null;
  const [game] = await db.select().from(gamesTable)
    .where(and(eq(gamesTable.id, player.gameId), eq(gamesTable.status, "published")))
    .limit(1);
  if (!game) return null;
  const checkpoints = await db.select().from(gameCheckpointsTable)
    .where(eq(gameCheckpointsTable.gameId, game.id))
    .orderBy(gameCheckpointsTable.position);
  const progress = await db.select({ checkpointId: gameProgressTable.checkpointId })
    .from(gameProgressTable)
    .where(eq(gameProgressTable.playerId, player.id));
  const solvedCount = solvedPrefixCount(checkpoints, new Set(progress.map((row) => row.checkpointId)));
  const snapshot = playerSnapshot(checkpoints.map((checkpoint) => ({
    position: checkpoint.position,
    hint: checkpoint.hint,
    lat: checkpoint.lat,
    lng: checkpoint.lng,
    imageUrl: checkpoint.imageUrl,
  })), solvedCount);
  const [organizer] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, game.ownerUserId)).limit(1);
  const ratings = await db.select({ value: gameRatingsTable.value }).from(gameRatingsTable).where(eq(gameRatingsTable.gameId, game.id));
  const [mine] = await db.select({ value: gameRatingsTable.value }).from(gameRatingsTable).where(eq(gameRatingsTable.playerId, player.id)).limit(1);
  return {
    gameId: game.id,
    title: game.title,
    description: game.description,
    nickname: player.nickname,
    teamName: player.teamName,
    organizerName: organizer?.name ?? "Organizator",
    organizerScore: organizerScore(ratings.map((rating) => rating.value)),
    joinedAt: player.joinedAt.toISOString(),
    finishedAt: player.finishedAt ? player.finishedAt.toISOString() : null,
    durationMs: player.finishedAt ? player.finishedAt.getTime() - player.joinedAt.getTime() : null,
    finished: snapshot.finished,
    solvedCount: snapshot.solvedCount,
    total: snapshot.total,
    current: snapshot.current,
    ranking: await loadRanking(game.id),
    myRating: mine?.value === 1 || mine?.value === -1 ? mine.value : null,
  };
}

router.post("/games", requireAdmin, async (req, res): Promise<void> => {
  const admin = res.locals.adminUser as AdminUser;
  const draft = validateGameDraft(req.body);
  if (!draft.ok) {
    res.status(draft.status).json({ error: draft.error });
    return;
  }
  for (const checkpoint of draft.checkpoints) {
    if (checkpoint.imageUrl != null && !isAllowedImageUrl(checkpoint.imageUrl)) {
      res.status(400).json({ error: `Zdjęcie punktu ${checkpoint.position} jest nieprawidłowe lub za duże.` });
      return;
    }
  }

  const hasUnlimitedPins = getRoleCapabilities(admin.role).hasUnlimitedPins;
  try {
    const outcome = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ pinBalance: usersTable.pinBalance })
        .from(usersTable)
        .where(eq(usersTable.id, admin.id))
        .limit(1)
        .for("update");
      const decision = evaluatePublish({
        pinBalance: owner?.pinBalance ?? 0,
        hasUnlimitedPins,
        checkpointCount: draft.checkpoints.length,
      });
      if (!decision.ok) return decision;
      if (decision.charge) {
        await tx.update(usersTable)
          .set({ pinBalance: sql`${usersTable.pinBalance} - 1` })
          .where(eq(usersTable.id, admin.id));
      }

      let createdGame: typeof gamesTable.$inferSelect | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const [inserted] = await tx.insert(gamesTable)
          .values({
            ownerUserId: admin.id,
            title: draft.title,
            description: draft.description,
            joinCode: genCode(),
            status: "published",
          })
          .onConflictDoNothing({ target: gamesTable.joinCode })
          .returning();
        if (inserted) {
          createdGame = inserted;
          break;
        }
      }
      if (!createdGame) {
        if (decision.charge) {
          await tx.update(usersTable)
            .set({ pinBalance: sql`${usersTable.pinBalance} + 1` })
            .where(eq(usersTable.id, admin.id));
        }
        throw new Error("Unable to allocate a unique game code");
      }

      await tx.insert(gameCheckpointsTable).values(draft.checkpoints.map((checkpoint) => ({
        gameId: createdGame.id,
        position: checkpoint.position,
        hint: checkpoint.hint,
        lat: checkpoint.lat,
        lng: checkpoint.lng,
        answerCode: checkpoint.answerCode,
        imageUrl: checkpoint.imageUrl,
      })));
      const [balance] = await tx.select({ pinBalance: usersTable.pinBalance }).from(usersTable).where(eq(usersTable.id, admin.id)).limit(1);
      return { ok: true as const, game: createdGame, charged: decision.charge, pinBalance: balance?.pinBalance ?? owner?.pinBalance ?? 0 };
    });

    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }

    await recordAudit("game_published", admin.id, admin.id, { gameId: outcome.game.id, title: outcome.game.title, charged: outcome.charged });
    res.status(201).json({
      id: outcome.game.id,
      title: outcome.game.title,
      description: outcome.game.description,
      joinCode: outcome.game.joinCode,
      createdAt: outcome.game.createdAt.toISOString(),
      checkpointCount: draft.checkpoints.length,
      playerCount: 0,
      finishedCount: 0,
      organizerScore: 0,
      charged: outcome.charged,
      pinBalance: outcome.pinBalance,
    });
  } catch (error) {
    req.log.error({ err: error }, "Game publish failed");
    res.status(500).json({ error: "Nie udało się opublikować gry." });
  }
});

router.get("/games", requireAdmin, async (_req, res): Promise<void> => {
  const admin = res.locals.adminUser as AdminUser;
  const games = await db.select().from(gamesTable)
    .where(and(eq(gamesTable.ownerUserId, admin.id), eq(gamesTable.status, "published")))
    .orderBy(desc(gamesTable.createdAt));
  res.setHeader("Cache-Control", "no-store");
  if (games.length === 0) {
    res.json([]);
    return;
  }
  const ids = games.map((game) => game.id);
  const [counts, players, scores] = await Promise.all([
    db.select({
      gameId: gameCheckpointsTable.gameId,
      checkpointCount: sql<number>`count(*)::int`,
    }).from(gameCheckpointsTable).where(inArray(gameCheckpointsTable.gameId, ids)).groupBy(gameCheckpointsTable.gameId),
    db.select({
      gameId: gamePlayersTable.gameId,
      playerCount: sql<number>`count(*)::int`,
      finishedCount: sql<number>`count(*) filter (where ${gamePlayersTable.finishedAt} is not null)::int`,
    }).from(gamePlayersTable).where(inArray(gamePlayersTable.gameId, ids)).groupBy(gamePlayersTable.gameId),
    db.select({
      gameId: gameRatingsTable.gameId,
      score: sql<number>`coalesce(sum(${gameRatingsTable.value}), 0)::int`,
    }).from(gameRatingsTable).where(inArray(gameRatingsTable.gameId, ids)).groupBy(gameRatingsTable.gameId),
  ]);
  const countByGame = new Map(counts.map((row) => [row.gameId, row.checkpointCount]));
  const playersByGame = new Map(players.map((row) => [row.gameId, row]));
  const scoreByGame = new Map(scores.map((row) => [row.gameId, row.score]));
  res.json(games.map((game) => ({
    id: game.id,
    title: game.title,
    description: game.description,
    joinCode: game.joinCode,
    createdAt: game.createdAt.toISOString(),
    checkpointCount: countByGame.get(game.id) ?? 0,
    playerCount: playersByGame.get(game.id)?.playerCount ?? 0,
    finishedCount: playersByGame.get(game.id)?.finishedCount ?? 0,
    organizerScore: scoreByGame.get(game.id) ?? 0,
  })));
});

router.post("/games/join", async (req, res): Promise<void> => {
  const limit = joinAttempts.hit(req.ip ?? "unknown");
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    res.status(429).json({ error: "Zbyt wiele prób kodu. Spróbuj ponownie za chwilę." });
    return;
  }
  const code = normalizeJoinCode(req.body?.code);
  const nickname = normalizeNickname(req.body?.nickname);
  const team = normalizeTeamName(req.body?.teamName);
  if (!code || !nickname || !team.ok) {
    res.status(400).json({ error: !team.ok ? team.error : "Podaj pięcioznakowy kod gry i nazwę gracza (2–24 znaki)." });
    return;
  }
  const [game] = await db.select().from(gamesTable)
    .where(and(eq(gamesTable.joinCode, code), eq(gamesTable.status, "published")))
    .limit(1);
  if (!game) {
    res.status(404).json({ error: "Nie ma gry o tym kodzie." });
    return;
  }

  const guestHash = ensureGuestHash(req, res);
  const [created] = await db.insert(gamePlayersTable).values({
    gameId: game.id,
    nickname,
    teamName: team.teamName,
    guestHash,
  }).onConflictDoNothing().returning();
  const player = created ?? await findPlayer(guestHash, game.id);
  if (!player) {
    res.status(500).json({ error: "Nie udało się dołączyć do gry." });
    return;
  }
  await db.update(gamePlayersTable).set({ lastSeenAt: new Date() }).where(eq(gamePlayersTable.id, player.id));
  const session = await buildPlayerSession(player.id);
  res.setHeader("Cache-Control", "no-store");
  res.status(created ? 201 : 200).json(session);
});

router.get("/games/session", async (req, res): Promise<void> => {
  const guestHash = readGuestHash(req);
  if (!guestHash) {
    res.status(401).json({ error: "Najpierw dołącz do gry." });
    return;
  }
  const player = await findPlayer(guestHash, optionalGameId(req.query.gameId));
  if (!player) {
    res.status(404).json({ error: "Nie znaleziono gry dla tej przeglądarki." });
    return;
  }
  const session = await buildPlayerSession(player.id);
  if (!session) {
    res.status(404).json({ error: "Nie znaleziono gry." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(session);
});

router.post("/games/session/attempt", async (req, res): Promise<void> => {
  const guestHash = readGuestHash(req);
  if (!guestHash) {
    res.status(401).json({ error: "Najpierw dołącz do gry." });
    return;
  }
  const gameId = Number(req.body?.gameId);
  if (!Number.isSafeInteger(gameId) || gameId < 1) {
    res.status(400).json({ error: "Brak identyfikatora gry." });
    return;
  }
  const player = await findPlayer(guestHash, gameId);
  if (!player) {
    res.status(404).json({ error: "Nie znaleziono Twojego udziału w tej grze." });
    return;
  }
  if (player.finishedAt) {
    res.status(409).json({ error: "Gra jest już ukończona." });
    return;
  }

  const checkpoints = await db.select({
    id: gameCheckpointsTable.id,
    position: gameCheckpointsTable.position,
    answerCode: gameCheckpointsTable.answerCode,
  }).from(gameCheckpointsTable)
    .where(eq(gameCheckpointsTable.gameId, player.gameId))
    .orderBy(gameCheckpointsTable.position);
  const progress = await db.select({ checkpointId: gameProgressTable.checkpointId })
    .from(gameProgressTable)
    .where(eq(gameProgressTable.playerId, player.id));
  const solvedCount = solvedPrefixCount(checkpoints, new Set(progress.map((row) => row.checkpointId)));
  const ordered = [...checkpoints].sort((a, b) => a.position - b.position);
  const current = ordered[solvedCount];
  const stateKey = current ? `${player.id}:${current.id}` : `${player.id}:done`;
  const state = checkpointAttempts.get(stateKey) ?? { wrongAttempts: 0, windowStartedAt: null };
  const decision = evaluateAttempt({
    checkpoints,
    solvedCount,
    answer: req.body?.answer,
    wrongAttempts: state.wrongAttempts,
    windowStartedAt: state.windowStartedAt,
    now: Date.now(),
  });
  if (!decision.correct || !decision.checkpointId) {
    rememberAttempt(stateKey, decision);
    if (decision.retryAfterSeconds) res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    res.status(decision.status).json({ error: decision.error ?? "Nie udało się sprawdzić kodu." });
    return;
  }

  checkpointAttempts.delete(stateKey);
  await db.transaction(async (tx) => {
    await tx.insert(gameProgressTable).values({
      playerId: player.id,
      checkpointId: decision.checkpointId!,
    }).onConflictDoNothing();
    const rows = await tx.select({ checkpointId: gameProgressTable.checkpointId })
      .from(gameProgressTable)
      .where(eq(gameProgressTable.playerId, player.id));
    const prefix = solvedPrefixCount(checkpoints, new Set(rows.map((row) => row.checkpointId)));
    await tx.update(gamePlayersTable).set({
      lastSeenAt: new Date(),
      ...(prefix >= checkpoints.length ? { finishedAt: player.finishedAt ?? new Date() } : {}),
    }).where(eq(gamePlayersTable.id, player.id));
  });
  const session = await buildPlayerSession(player.id);
  res.setHeader("Cache-Control", "no-store");
  res.json(session);
});

router.post("/games/session/rating", async (req, res): Promise<void> => {
  const guestHash = readGuestHash(req);
  if (!guestHash) {
    res.status(401).json({ error: "Najpierw dołącz do gry." });
    return;
  }
  const gameId = Number(req.body?.gameId);
  if (!Number.isSafeInteger(gameId) || gameId < 1) {
    res.status(400).json({ error: "Brak identyfikatora gry." });
    return;
  }
  const player = await findPlayer(guestHash, gameId);
  if (!player) {
    res.status(404).json({ error: "Nie znaleziono Twojego udziału w tej grze." });
    return;
  }
  const [existing] = await db.select({ value: gameRatingsTable.value })
    .from(gameRatingsTable)
    .where(eq(gameRatingsTable.playerId, player.id))
    .limit(1);
  const decision = evaluateRating({
    finished: Boolean(player.finishedAt),
    existingValue: existing?.value ?? null,
    value: req.body?.value,
  });
  if (!decision.ok) {
    res.status(decision.status).json({ error: decision.error });
    return;
  }
  const [saved] = await db.insert(gameRatingsTable).values({
    gameId: player.gameId,
    playerId: player.id,
    value: decision.value,
  }).onConflictDoNothing().returning({ id: gameRatingsTable.id });
  if (!saved) {
    res.status(409).json({ error: "Organizator został już oceniony w tej grze." });
    return;
  }
  const [game] = await db.select({ ownerUserId: gamesTable.ownerUserId }).from(gamesTable).where(eq(gamesTable.id, player.gameId)).limit(1);
  await recordAudit("game_rated", null, game?.ownerUserId ?? null, { gameId: player.gameId, value: decision.value });
  const session = await buildPlayerSession(player.id);
  res.setHeader("Cache-Control", "no-store");
  res.json(session);
});

router.get("/games/:gameId", requireAdmin, async (req, res): Promise<void> => {
  const admin = res.locals.adminUser as AdminUser;
  const gameId = optionalGameId(req.params.gameId);
  if (!gameId) {
    res.status(400).json({ error: "Nieprawidłowa gra." });
    return;
  }
  const [game] = await db.select().from(gamesTable)
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerUserId, admin.id), eq(gamesTable.status, "published")))
    .limit(1);
  if (!game) {
    res.status(404).json({ error: "Nie znaleziono gry." });
    return;
  }
  const checkpoints = await db.select().from(gameCheckpointsTable)
    .where(eq(gameCheckpointsTable.gameId, game.id))
    .orderBy(gameCheckpointsTable.position);
  const ratings = await db.select({ value: gameRatingsTable.value }).from(gameRatingsTable).where(eq(gameRatingsTable.gameId, game.id));
  res.setHeader("Cache-Control", "no-store");
  res.json({
    id: game.id,
    title: game.title,
    description: game.description,
    joinCode: game.joinCode,
    createdAt: game.createdAt.toISOString(),
    organizerScore: organizerScore(ratings.map((rating) => rating.value)),
    checkpoints: checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      position: checkpoint.position,
      hint: checkpoint.hint,
      lat: checkpoint.lat,
      lng: checkpoint.lng,
      answerCode: checkpoint.answerCode,
      hasImage: Boolean(checkpoint.imageUrl),
    })),
    ranking: await loadRanking(game.id),
  });
});

export default router;
