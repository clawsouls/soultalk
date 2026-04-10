import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "..", "soultalk.db");
const db = new Database(DB_PATH);

// Initialize tables
db.run(`CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'group',  -- '1:1', 'group', 'broadcast'
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
)`);

db.run(`CREATE TABLE IF NOT EXISTS members (
  channel_id TEXT NOT NULL,
  soul_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  engine TEXT DEFAULT '',
  joined_at TEXT DEFAULT (datetime('now')),
  role TEXT DEFAULT 'member',  -- 'owner', 'member', 'observer'
  PRIMARY KEY (channel_id, soul_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
)`);

db.run(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_soul_id TEXT NOT NULL,
  sender_identity TEXT NOT NULL,
  type TEXT DEFAULT 'message',  -- message, tool_request, tool_result, state_sync, approval_request, approval_response, system
  content TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  priority TEXT DEFAULT 'normal',  -- normal, high, urgent
  requires_approval INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(channel_id, type)`);

// Phase 3: Audit log
db.run(`CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT DEFAULT (datetime('now')),
  actor_soul_id TEXT NOT NULL,
  actor_identity TEXT NOT NULL,
  action TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  details TEXT DEFAULT '{}',
  ip_address TEXT DEFAULT ''
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_audit_channel ON audit_log(channel_id, timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_soul_id, timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, timestamp)`);

// Phase 3: Approval status tracking
db.run(`CREATE TABLE IF NOT EXISTS approval_status (
  message_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  responder_soul_id TEXT,
  responder_identity TEXT,
  responded_at TEXT,
  comment TEXT DEFAULT '',
  FOREIGN KEY (message_id) REFERENCES messages(id)
)`);

export default db;
