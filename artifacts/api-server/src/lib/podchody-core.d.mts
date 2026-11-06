export const MIN_CHECKPOINTS: number;
export const MAX_CHECKPOINTS: number;
export const MAX_WRONG_ATTEMPTS: number;
export const ATTEMPT_WINDOW_MS: number;

export type CheckpointDraft = {
  position: number;
  hint: string;
  answerCode: string;
  lat: number;
  lng: number;
  imageUrl: string | null;
};

export type GameDraft =
  | { ok: true; title: string; description: string; checkpoints: CheckpointDraft[] }
  | { ok: false; status: number; error: string };

export type PublishDecision =
  | { ok: true; charge: boolean }
  | { ok: false; status: number; error: string };

export type SnapshotCheckpoint = {
  position: number;
  hint: string;
  lat: number;
  lng: number;
  imageUrl?: string | null;
};

export type PlayerSnapshot = {
  finished: boolean;
  solvedCount: number;
  total: number;
  current: null | {
    position: number;
    hint: string;
    imageUrl: string | null;
    area: { lat: number; lng: number; radiusMeters: number };
  };
};

export type AttemptCheckpoint = {
  id: number;
  position: number;
  answerCode: string;
};

export type AttemptDecision = {
  status: number;
  error?: string;
  correct?: boolean;
  finished?: boolean;
  solvedCount?: number;
  checkpointId?: number;
  wrongAttempts: number;
  windowStartedAt: number | null;
  retryAfterSeconds?: number;
};

export type RatingDecision =
  | { ok: true; value: 1 | -1 }
  | { ok: false; status: number; error: string };

export type RankingEntry = {
  place: number;
  nickname: string;
  teamName: string | null;
  solvedCount: number;
  finished: boolean;
  durationMs: number | null;
};

export function normalizeAnswer(value: unknown): string;
export function normalizeJoinCode(value: unknown): string | null;
export function normalizeNickname(value: unknown): string | null;
export function normalizeTeamName(value: unknown): { ok: true; teamName: string | null } | { ok: false; error: string };
export function validateGameDraft(input: unknown): GameDraft;
export function evaluatePublish(input: {
  pinBalance: number;
  hasUnlimitedPins: boolean;
  checkpointCount: number;
}): PublishDecision;
export function approximateArea(lat: number, lng: number, position: number): { lat: number; lng: number; radiusMeters: number };
export function playerSnapshot(checkpoints: SnapshotCheckpoint[], solvedCount: number): PlayerSnapshot;
export function solvedPrefixCount(checkpoints: Array<{ id: number; position: number }>, solvedIds: Set<number>): number;
export function evaluateAttempt(input: {
  checkpoints: AttemptCheckpoint[];
  solvedCount: number;
  answer: unknown;
  wrongAttempts: number;
  windowStartedAt: number | null;
  now: number;
}): AttemptDecision;
export function evaluateRating(input: {
  finished: boolean;
  existingValue: number | null;
  value: unknown;
}): RatingDecision;
export function organizerScore(values: number[]): number;
export function rankPlayers(players: Array<{
  nickname: string;
  teamName?: string | null;
  solvedCount?: number;
  joinedAt: string | Date;
  finishedAt?: string | Date | null;
}>): RankingEntry[];
