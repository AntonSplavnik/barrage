import { createClient } from "@libsql/client";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "barrage.db");

const db = createClient({ url: `file:${DB_PATH}` });

export async function initDb() {
  await db.execute("PRAGMA journal_mode = WAL");
  await db.execute("PRAGMA foreign_keys = ON");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS game_sessions (
      id TEXT PRIMARY KEY,
      host_user_id INTEGER NOT NULL,
      guest_user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'waiting',
      offer_sdp TEXT,
      answer_sdp TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(host_user_id) REFERENCES users(id),
      FOREIGN KEY(guest_user_id) REFERENCES users(id)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ice_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      from_role TEXT NOT NULL,
      candidate TEXT NOT NULL,
      delivered INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES game_sessions(id)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS game_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      winner_user_id INTEGER,
      loser_user_id INTEGER,
      rounds_played INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS player_stats (
      user_id       INTEGER PRIMARY KEY,
      battles_won   INTEGER NOT NULL DEFAULT 0,
      battles_lost  INTEGER NOT NULL DEFAULT 0,
      wars_won      INTEGER NOT NULL DEFAULT 0,
      wars_lost     INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS war_opponents (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      winner_user_id  INTEGER NOT NULL,
      loser_user_id   INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY(winner_user_id) REFERENCES users(id),
      FOREIGN KEY(loser_user_id)  REFERENCES users(id)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS round_results (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT    NOT NULL,
      round_number  INTEGER NOT NULL,
      winner_user_id INTEGER,
      loser_user_id  INTEGER,
      created_at    INTEGER NOT NULL,
      UNIQUE(session_id, round_number)
    )
  `);

  // Migrations — safe to run repeatedly (ADD COLUMN fails silently if column exists)
  for (const sql of [
    "ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN display_name TEXT",
  ]) {
    try { await db.execute(sql); } catch { /* column already exists */ }
  }

  // Expire stale signaling sessions (older than 10 minutes, still in waiting/signaling)
  const staleExpiry = Date.now() - 10 * 60 * 1000;
  await db.execute({
    sql: `DELETE FROM ice_candidates WHERE session_id IN (
      SELECT id FROM game_sessions
      WHERE status IN ('waiting', 'signaling') AND created_at < ?
    )`,
    args: [staleExpiry],
  });
  await db.execute({
    sql: `DELETE FROM game_sessions WHERE status IN ('waiting', 'signaling') AND created_at < ?`,
    args: [staleExpiry],
  });
}

export default db;
