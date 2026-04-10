import { Hono } from "hono";
import { cors } from "hono/cors";
import db from "./db";
import { randomUUID } from "crypto";

const app = new Hono();
app.use("*", cors());

// Health check
app.get("/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

// --- Channels ---

// Create channel
app.post("/channels", async (c) => {
  const { name, type, soul_id, identity, engine } = await c.req.json();
  const id = randomUUID().slice(0, 8);

  db.run(
    "INSERT INTO channels (id, name, type, created_by) VALUES (?, ?, ?, ?)",
    [id, name, type || "group", soul_id]
  );

  // Auto-join creator as owner
  db.run(
    "INSERT INTO members (channel_id, soul_id, identity, engine, role) VALUES (?, ?, ?, ?, 'owner')",
    [id, soul_id, identity, engine || ""]
  );

  return c.json({ id, name, type: type || "group" }, 201);
});

// List channels for a soul
app.get("/channels", (c) => {
  const soul_id = c.req.query("soul_id");
  if (!soul_id) return c.json({ error: "soul_id required" }, 400);

  const channels = db
    .query(
      `
    SELECT c.id, c.name, c.type, c.created_at,
      (SELECT COUNT(*) FROM members WHERE channel_id = c.id) as member_count,
      (SELECT COUNT(*) FROM messages WHERE channel_id = c.id) as message_count
    FROM channels c
    JOIN members m ON c.id = m.channel_id
    WHERE m.soul_id = ?
  `
    )
    .all(soul_id);

  return c.json({ channels });
});

// Join channel
app.post("/channels/:id/join", async (c) => {
  const channelId = c.req.param("id");
  const { soul_id, identity, engine, role } = await c.req.json();

  // Check channel exists
  const channel = db
    .query("SELECT * FROM channels WHERE id = ?")
    .get(channelId);
  if (!channel) return c.json({ error: "Channel not found" }, 404);

  // Check not already member
  const existing = db
    .query("SELECT * FROM members WHERE channel_id = ? AND soul_id = ?")
    .get(channelId, soul_id);
  if (existing) return c.json({ error: "Already a member" }, 409);

  db.run(
    "INSERT INTO members (channel_id, soul_id, identity, engine, role) VALUES (?, ?, ?, ?, ?)",
    [channelId, soul_id, identity, engine || "", role || "member"]
  );

  // System message
  const msgId = randomUUID();
  db.run(
    "INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content) VALUES (?, ?, 'SYSTEM', 'System', 'system', ?)",
    [msgId, channelId, `${identity} joined the channel`]
  );

  return c.json({ joined: true, channel_id: channelId });
});

// --- Messages ---

// Send message
app.post("/channels/:id/messages", async (c) => {
  const channelId = c.req.param("id");
  const {
    soul_id,
    identity,
    type,
    content,
    metadata,
    priority,
    requires_approval,
  } = await c.req.json();

  // Verify membership
  const member = db
    .query("SELECT * FROM members WHERE channel_id = ? AND soul_id = ?")
    .get(channelId, soul_id);
  if (!member) return c.json({ error: "Not a member of this channel" }, 403);

  const id = randomUUID();
  db.run(
    `INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content, metadata, priority, requires_approval)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      channelId,
      soul_id,
      identity,
      type || "message",
      content,
      JSON.stringify(metadata || {}),
      priority || "normal",
      requires_approval ? 1 : 0,
    ]
  );

  return c.json(
    { id, channel_id: channelId, created_at: new Date().toISOString() },
    201
  );
});

// Read messages (polling)
app.get("/channels/:id/messages", (c) => {
  const channelId = c.req.param("id");
  const since = c.req.query("since"); // ISO timestamp
  const limit = parseInt(c.req.query("limit") || "50");
  const type_filter = c.req.query("type"); // optional type filter

  let query = "SELECT * FROM messages WHERE channel_id = ?";
  const params: any[] = [channelId];

  if (since) {
    query += " AND created_at > ?";
    params.push(since);
  }
  if (type_filter) {
    query += " AND type = ?";
    params.push(type_filter);
  }

  query += " ORDER BY created_at ASC LIMIT ?";
  params.push(limit);

  const messages = db.query(query).all(...params);
  return c.json({ messages, channel_id: channelId });
});

// --- Status ---

// Channel status (members, unread count)
app.get("/channels/:id/status", (c) => {
  const channelId = c.req.param("id");
  const since = c.req.query("since");

  const channel = db
    .query("SELECT * FROM channels WHERE id = ?")
    .get(channelId);
  if (!channel) return c.json({ error: "Channel not found" }, 404);

  const members = db
    .query(
      "SELECT soul_id, identity, engine, role, joined_at FROM members WHERE channel_id = ?"
    )
    .all(channelId);

  let unread = 0;
  if (since) {
    const result = db
      .query(
        "SELECT COUNT(*) as count FROM messages WHERE channel_id = ? AND created_at > ?"
      )
      .get(channelId, since);
    unread = (result as any).count;
  }

  const total = (
    db
      .query("SELECT COUNT(*) as count FROM messages WHERE channel_id = ?")
      .get(channelId) as any
  ).count;

  return c.json({ channel, members, message_count: total, unread });
});

// Pending approvals
app.get("/channels/:id/approvals", (c) => {
  const channelId = c.req.param("id");
  const approvals = db
    .query(
      "SELECT * FROM messages WHERE channel_id = ? AND requires_approval = 1 AND type = 'approval_request' ORDER BY created_at DESC"
    )
    .all(channelId);
  return c.json({ approvals });
});

// Respond to approval
app.post("/channels/:id/approvals/:msgId", async (c) => {
  const channelId = c.req.param("id");
  const msgId = c.req.param("msgId");
  const { soul_id, identity, approved, comment } = await c.req.json();

  const responseId = randomUUID();
  const content = JSON.stringify({
    original_message_id: msgId,
    approved,
    comment: comment || "",
  });

  db.run(
    `INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content) VALUES (?, ?, ?, ?, 'approval_response', ?)`,
    [responseId, channelId, soul_id, identity, content]
  );

  return c.json({ id: responseId, approved });
});

const PORT = parseInt(process.env.SOULTALK_PORT || "7777");
console.log(`SoulTalk server running on http://localhost:${PORT}`);
export default { port: PORT, fetch: app.fetch };
