export type GameArea = { lat: number; lng: number; radiusMeters: number };

export type GameCheckpointView = {
  position: number;
  hint: string;
  imageUrl: string | null;
  area: GameArea;
};

export type GameRankingEntry = {
  place: number;
  nickname: string;
  teamName: string | null;
  solvedCount: number;
  finished: boolean;
  durationMs: number | null;
};

export type GameSession = {
  gameId: number;
  title: string;
  description: string;
  nickname: string;
  teamName: string | null;
  organizerName: string;
  organizerScore: number;
  joinedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  finished: boolean;
  solvedCount: number;
  total: number;
  current: GameCheckpointView | null;
  ranking: GameRankingEntry[];
  myRating: number | null;
};

export type OrganizerGame = {
  id: number;
  title: string;
  description: string;
  joinCode: string;
  createdAt: string;
  checkpointCount: number;
  playerCount: number;
  finishedCount: number;
  organizerScore: number;
};

export function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} godz. ${minutes} min`;
  return `${minutes} min ${seconds.toString().padStart(2, "0")} s`;
}
