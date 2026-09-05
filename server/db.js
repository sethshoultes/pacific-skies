// SQLite connection (node:sqlite, no external driver) and schema migrations. Every other server
// module imports `db`/`now` from here rather than opening its own connection.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'pacific-skies.sqlite');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS achievements (
  user_id INTEGER NOT NULL,
  ach_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ach_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  score INTEGER NOT NULL,
  stage_reached INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'solo',
  ended_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_score ON runs(score DESC);
CREATE TABLE IF NOT EXISTS prefs (
  user_id INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  guest_id TEXT,
  kind TEXT NOT NULL,
  data TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  url TEXT,
  user_id INTEGER,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS errors_ts ON errors(ts DESC);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const now = () => Math.floor(Date.now() / 1000);
