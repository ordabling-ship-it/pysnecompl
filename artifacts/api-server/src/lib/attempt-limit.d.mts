export type AttemptHit = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function createAttemptWindow(options: { limit: number; windowMs: number }): {
  hit: (key: string, now?: number) => AttemptHit;
};
