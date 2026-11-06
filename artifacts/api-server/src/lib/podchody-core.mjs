export const MIN_CHECKPOINTS = 2;
export const MAX_CHECKPOINTS = 10;
export const MAX_WRONG_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

const ANSWER_PATTERN = /^[A-Z0-9]{3,12}$/;
const NICKNAME_PATTERN = /^[\p{L}\p{N} _.-]+$/u;

export function normalizeAnswer(value) {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function normalizeJoinCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{5}$/.test(code) ? code : null;
}

export function normalizeNickname(value) {
  if (typeof value !== "string") return null;
  const nickname = value.trim().replace(/\s+/g, " ");
  if (nickname.length < 2 || nickname.length > 24 || !NICKNAME_PATTERN.test(nickname)) return null;
  return nickname;
}

export function normalizeTeamName(value) {
  if (value == null || value === "") return { ok: true, teamName: null };
  if (typeof value !== "string") return { ok: false, error: "Nazwa zespołu jest nieprawidłowa." };
  const teamName = value.trim().replace(/\s+/g, " ");
  if (teamName.length === 0) return { ok: true, teamName: null };
  if (teamName.length < 2 || teamName.length > 32 || !NICKNAME_PATTERN.test(teamName)) {
    return { ok: false, error: "Nazwa zespołu może mieć od 2 do 32 znaków." };
  }
  return { ok: true, teamName };
}

export function validateGameDraft(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, status: 400, error: "Dane gry są nieprawidłowe." };
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (title.length < 3 || title.length > 80) {
    return { ok: false, status: 400, error: "Tytuł gry musi mieć od 3 do 80 znaków." };
  }
  if (description.length < 1 || description.length > 500) {
    return { ok: false, status: 400, error: "Opis gry musi mieć od 1 do 500 znaków." };
  }
  if (!Array.isArray(input.checkpoints) || input.checkpoints.length < MIN_CHECKPOINTS || input.checkpoints.length > MAX_CHECKPOINTS) {
    return { ok: false, status: 400, error: "Gra musi mieć od 2 do 10 punktów." };
  }

  const checkpoints = [];
  for (let index = 0; index < input.checkpoints.length; index += 1) {
    const raw = input.checkpoints[index];
    if (!raw || typeof raw !== "object") {
      return { ok: false, status: 400, error: `Punkt ${index + 1} jest nieprawidłowy.` };
    }
    const hint = typeof raw.hint === "string" ? raw.hint.trim() : "";
    const answerCode = normalizeAnswer(raw.answerCode ?? "");
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (hint.length < 1 || hint.length > 500) {
      return { ok: false, status: 400, error: `Wskazówka punktu ${index + 1} musi mieć od 1 do 500 znaków.` };
    }
    if (!ANSWER_PATTERN.test(answerCode)) {
      return { ok: false, status: 400, error: `Kod punktu ${index + 1} musi mieć od 3 do 12 liter lub cyfr.` };
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return { ok: false, status: 400, error: `Punkt ${index + 1} nie ma miejsca na mapie.` };
    }
    const imageUrl = raw.imageUrl == null || raw.imageUrl === "" ? null : raw.imageUrl;
    if (imageUrl != null && typeof imageUrl !== "string") {
      return { ok: false, status: 400, error: `Zdjęcie punktu ${index + 1} jest nieprawidłowe.` };
    }
    checkpoints.push({ position: index + 1, hint, answerCode, lat, lng, imageUrl });
  }

  return { ok: true, title, description, checkpoints };
}

export function evaluatePublish({ pinBalance, hasUnlimitedPins, checkpointCount }) {
  if (!Number.isInteger(checkpointCount) || checkpointCount < MIN_CHECKPOINTS || checkpointCount > MAX_CHECKPOINTS) {
    return { ok: false, status: 400, error: "Gra musi mieć od 2 do 10 punktów." };
  }
  if (hasUnlimitedPins) return { ok: true, charge: false };
  if (typeof pinBalance === "number" && pinBalance > 0) return { ok: true, charge: true };
  return {
    ok: false,
    status: 402,
    error: "Wykorzystano wszystkie pinezki. Wybierz pakiet, aby dodać kolejne.",
  };
}

export function approximateArea(lat, lng, position) {
  const angle = ((Number(position) * 137.507) % 360) * Math.PI / 180;
  const meters = 220;
  const dLat = (meters * Math.cos(angle)) / 111320;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = Math.abs(cos) < 1e-6 ? 0 : (meters * Math.sin(angle)) / (111320 * cos);
  return {
    lat: Math.round((lat + dLat) * 1e6) / 1e6,
    lng: Math.round((lng + dLng) * 1e6) / 1e6,
    radiusMeters: 450,
  };
}

export function playerSnapshot(checkpoints, solvedCount) {
  const ordered = [...checkpoints].sort((a, b) => a.position - b.position);
  const total = ordered.length;
  const solved = Math.max(0, Math.min(Number(solvedCount) || 0, total));
  const finished = total > 0 && solved >= total;
  const current = finished ? null : ordered[solved];
  return {
    finished,
    solvedCount: solved,
    total,
    current: current
      ? {
          position: current.position,
          hint: current.hint,
          imageUrl: current.imageUrl ?? null,
          area: approximateArea(current.lat, current.lng, current.position),
        }
      : null,
  };
}

export function solvedPrefixCount(checkpoints, solvedIds) {
  const ordered = [...checkpoints].sort((a, b) => a.position - b.position);
  let count = 0;
  for (const checkpoint of ordered) {
    if (!solvedIds.has(checkpoint.id)) break;
    count += 1;
  }
  return count;
}

export function evaluateAttempt({ checkpoints, solvedCount, answer, wrongAttempts, windowStartedAt, now }) {
  const ordered = [...checkpoints].sort((a, b) => a.position - b.position);
  const solved = Math.max(0, solvedCount);
  if (solved >= ordered.length) {
    return {
      status: 409,
      error: "Gra jest już ukończona.",
      finished: true,
      correct: false,
      solvedCount: ordered.length,
      wrongAttempts: 0,
      windowStartedAt: null,
    };
  }

  const current = ordered[solved];
  const inWindow = typeof windowStartedAt === "number" && now - windowStartedAt < ATTEMPT_WINDOW_MS;
  const failures = inWindow ? wrongAttempts : 0;
  const windowStart = inWindow ? windowStartedAt : now;
  if (failures >= MAX_WRONG_ATTEMPTS) {
    return {
      status: 429,
      error: "Zbyt wiele błędnych kodów. Odczekaj 10 minut.",
      correct: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + ATTEMPT_WINDOW_MS - now) / 1000)),
      wrongAttempts: failures,
      windowStartedAt: windowStart,
      solvedCount: solved,
    };
  }

  if (normalizeAnswer(answer) !== normalizeAnswer(current.answerCode)) {
    const nextFailures = failures + 1;
    if (nextFailures >= MAX_WRONG_ATTEMPTS) {
      return {
        status: 429,
        error: "Zbyt wiele błędnych kodów. Odczekaj 10 minut.",
        correct: false,
        retryAfterSeconds: Math.ceil(ATTEMPT_WINDOW_MS / 1000),
        wrongAttempts: nextFailures,
        windowStartedAt: windowStart,
        solvedCount: solved,
      };
    }
    return {
      status: 400,
      error: "To nie jest kod tego punktu.",
      correct: false,
      wrongAttempts: nextFailures,
      windowStartedAt: windowStart,
      solvedCount: solved,
    };
  }

  const nextSolved = solved + 1;
  return {
    status: 200,
    correct: true,
    finished: nextSolved >= ordered.length,
    solvedCount: nextSolved,
    checkpointId: current.id,
    wrongAttempts: 0,
    windowStartedAt: null,
  };
}

export function evaluateRating({ finished, existingValue, value }) {
  if (!finished) {
    return { ok: false, status: 409, error: "Ocenę można wystawić po ukończeniu gry." };
  }
  if (existingValue === 1 || existingValue === -1) {
    return { ok: false, status: 409, error: "Organizator został już oceniony w tej grze." };
  }
  if (value !== 1 && value !== -1) {
    return { ok: false, status: 400, error: "Ocena to kciuk w górę albo w dół." };
  }
  return { ok: true, value };
}

export function organizerScore(values) {
  return values.reduce((sum, value) => sum + (value === 1 || value === -1 ? value : 0), 0);
}

export function rankPlayers(players) {
  const ranked = [...players].sort((a, b) => {
    const aDone = Boolean(a.finishedAt);
    const bDone = Boolean(b.finishedAt);
    if (aDone && bDone) {
      const aDuration = new Date(a.finishedAt).getTime() - new Date(a.joinedAt).getTime();
      const bDuration = new Date(b.finishedAt).getTime() - new Date(b.joinedAt).getTime();
      if (aDuration !== bDuration) return aDuration - bDuration;
    } else if (aDone !== bDone) {
      return aDone ? -1 : 1;
    } else if ((b.solvedCount ?? 0) !== (a.solvedCount ?? 0)) {
      return (b.solvedCount ?? 0) - (a.solvedCount ?? 0);
    }
    return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
  });

  return ranked.map((player, index) => ({
    place: index + 1,
    nickname: player.nickname,
    teamName: player.teamName ?? null,
    solvedCount: player.solvedCount ?? 0,
    finished: Boolean(player.finishedAt),
    durationMs: player.finishedAt
      ? new Date(player.finishedAt).getTime() - new Date(player.joinedAt).getTime()
      : null,
  }));
}
