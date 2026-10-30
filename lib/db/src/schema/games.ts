import { doublePrecision, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const gamesTable = pgTable("games", {
  id: serial("id").primaryKey(),
  ownerUserId: integer("owner_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  joinCode: text("join_code").notNull().unique(),
  status: text("status").notNull().default("published"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gameCheckpointsTable = pgTable("game_checkpoints", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull().references(() => gamesTable.id, { onDelete: "restrict" }),
  position: integer("position").notNull(),
  hint: text("hint").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  answerCode: text("answer_code").notNull(),
  imageUrl: text("image_url"),
}, (table) => ({
  gamePositionUnique: uniqueIndex("game_checkpoints_game_position_unique").on(table.gameId, table.position),
}));

export const gamePlayersTable = pgTable("game_players", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull().references(() => gamesTable.id, { onDelete: "restrict" }),
  nickname: text("nickname").notNull(),
  teamName: text("team_name"),
  guestHash: text("guest_hash").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => ({
  gameGuestUnique: uniqueIndex("game_players_game_guest_unique").on(table.gameId, table.guestHash),
}));

export const gameProgressTable = pgTable("game_progress", {
  id: serial("id").primaryKey(),
  playerId: integer("player_id").notNull().references(() => gamePlayersTable.id, { onDelete: "restrict" }),
  checkpointId: integer("checkpoint_id").notNull().references(() => gameCheckpointsTable.id, { onDelete: "restrict" }),
  solvedAt: timestamp("solved_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  playerCheckpointUnique: uniqueIndex("game_progress_player_checkpoint_unique").on(table.playerId, table.checkpointId),
}));

export const gameRatingsTable = pgTable("game_ratings", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull().references(() => gamesTable.id, { onDelete: "restrict" }),
  playerId: integer("player_id").notNull().references(() => gamePlayersTable.id, { onDelete: "restrict" }),
  value: integer("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  playerUnique: uniqueIndex("game_ratings_player_unique").on(table.playerId),
}));
