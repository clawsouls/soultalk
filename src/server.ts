import { Hono } from "hono";
import { cors } from "hono/cors";
import db from "./db";
import { randomUUID } from "crypto";
import { logAudit } from "./audit";
import { connectionManager, validateUpgrade, getRecentMessages, type WSData } from "./ws";

const app = new Hono();
app.use("*", cors());

// Health check
app.get("/health", (c) => c.json({ status: "ok", version: "0.3.0" }));

// --- Dashboard ---

app.get("/dashboard", async (c) => {
  const html = await Bun.file("public/dashboard.html").text();
  return c.html(html);
});

// --- Channels ---

// List ALL channels (for dashboard/observer)
app.get("/channels/all", (c) => {
  const channels = db
    .query(
      `SELECT c.id, c.name, c.type, c.created_at,
        (SELECT COUNT(*) FROM members WHERE channel_id = c.id) as member_count,
        (SELECT COUNT(*) FROM messages WHERE channel_id = c.id) as message_count
      FROM channels c
      ORDER BY c.created_at DESC`
    )
    .all();
  return c.json({ channels });
});

// Create channel
app.post("/channels", async (c) => {
  const { name, type, soul_id, identity, engine, metadata } =
    await c.req.json();
  const id = randomUUID().slice(0, 8);

  db.run(
    "INSERT INTO channels (id, name, type, created_by, metadata) VALUES (?, ?, ?, ?, ?)",
    [id, name, type || "group", soul_id, JSON.stringify(metadata || {})]
  );

  // Auto-join creator as owner
  db.run(
    "INSERT INTO members (channel_id, soul_id, identity, engine, role) VALUES (?, ?, ?, ?, 'owner')",
    [id, soul_id, identity, engine || ""]
  );

  logAudit(soul_id, identity, "create_channel", {
    channel_id: id,
    channel_name: name,
    channel_type: type || "group",
  });

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
  const joinedAt = new Date().toISOString();
  db.run(
    "INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content, created_at) VALUES (?, ?, 'SYSTEM', 'System', 'system', ?, ?)",
    [msgId, channelId, `${identity} joined the channel`, joinedAt]
  );

  // Broadcast member joined via WebSocket
  connectionManager.broadcast(channelId, {
    type: "system",
    data: {
      id: msgId,
      channel_id: channelId,
      sender_soul_id: "SYSTEM",
      sender_identity: "System",
      type: "system",
      content: `${identity} joined the channel`,
      created_at: joinedAt,
    },
  });

  logAudit(soul_id, identity, "join_channel", {
    channel_id: channelId,
    role: role || "member",
  });

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
  const created_at = new Date().toISOString();

  db.run(
    `INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content, metadata, priority, requires_approval, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      created_at,
    ]
  );

  // If requires_approval, create a pending approval_status record
  if (requires_approval) {
    db.run(
      "INSERT INTO approval_status (message_id, status) VALUES (?, 'pending')",
      [id]
    );

    // Webhook notification: check channel metadata for webhook_url
    try {
      const channel = db
        .query("SELECT metadata FROM channels WHERE id = ?")
        .get(channelId) as { metadata: string } | null;
      if (channel) {
        const channelMeta = JSON.parse(channel.metadata || "{}");
        if (channelMeta.webhook_url) {
          // Fire-and-forget webhook
          fetch(channelMeta.webhook_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: "approval_required",
              channel_id: channelId,
              message_id: id,
              sender_soul_id: soul_id,
              sender_identity: identity,
              content,
              priority: priority || "normal",
            }),
          }).catch(() => {});
        }
      }
    } catch {
      // Non-blocking: webhook failure should not affect message delivery
    }
  }

  // Broadcast to WebSocket connections
  const memberData = member as any;
  connectionManager.broadcast(channelId, {
    type: "message",
    data: {
      id,
      channel_id: channelId,
      sender_soul_id: soul_id,
      sender_identity: identity,
      engine: memberData.engine || "",
      type: type || "message",
      content,
      metadata: metadata || {},
      priority: priority || "normal",
      requires_approval: requires_approval ? 1 : 0,
      created_at,
    },
  });

  logAudit(soul_id, identity, "send_message", {
    channel_id: channelId,
    message_id: id,
    message_type: type || "message",
    requires_approval: !!requires_approval,
  });

  return c.json(
    { id, channel_id: channelId, created_at },
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

  return c.json({
    channel,
    members,
    message_count: total,
    unread,
    ws_connections: connectionManager.getConnectionCount(channelId),
  });
});

// --- Approvals (Phase 3 Enhanced) ---

// List approvals with status
app.get("/channels/:id/approvals", (c) => {
  const channelId = c.req.param("id");
  const status = c.req.query("status"); // optional: pending, approved, rejected, timed_out

  let query = `
    SELECT m.*, COALESCE(a.status, 'pending') as approval_status,
           a.responder_soul_id, a.responder_identity, a.responded_at, a.comment as approval_comment
    FROM messages m
    LEFT JOIN approval_status a ON m.id = a.message_id
    WHERE m.channel_id = ? AND m.requires_approval = 1`;
  const params: any[] = [channelId];

  if (status) {
    query += " AND COALESCE(a.status, 'pending') = ?";
    params.push(status);
  }

  query += " ORDER BY m.created_at DESC";

  const approvals = db.query(query).all(...params);
  return c.json({ approvals });
});

// Pending approvals only
app.get("/channels/:id/approvals/pending", (c) => {
  const channelId = c.req.param("id");

  const approvals = db
    .query(
      `SELECT m.*, 'pending' as approval_status
       FROM messages m
       LEFT JOIN approval_status a ON m.id = a.message_id
       WHERE m.channel_id = ? AND m.requires_approval = 1
         AND COALESCE(a.status, 'pending') = 'pending'
       ORDER BY m.created_at DESC`
    )
    .all(channelId);

  return c.json({ approvals });
});

// Respond to approval (enhanced)
app.post("/channels/:id/approvals/:msgId", async (c) => {
  const channelId = c.req.param("id");
  const msgId = c.req.param("msgId");
  const { soul_id, identity, approved, comment } = await c.req.json();

  // Validate the original message exists and requires approval
  const original = db
    .query(
      "SELECT * FROM messages WHERE id = ? AND channel_id = ? AND requires_approval = 1"
    )
    .get(msgId, channelId);
  if (!original)
    return c.json({ error: "Approval request not found" }, 404);

  // Validate approver has owner or observer role
  const approver = db
    .query("SELECT * FROM members WHERE channel_id = ? AND soul_id = ?")
    .get(channelId, soul_id) as { role: string } | null;
  if (!approver)
    return c.json({ error: "Not a member of this channel" }, 403);
  if (approver.role !== "owner" && approver.role !== "observer")
    return c.json(
      { error: "Only owners or observers can approve/reject" },
      403
    );

  // Check not already responded
  const existingApproval = db
    .query(
      "SELECT * FROM approval_status WHERE message_id = ? AND status != 'pending'"
    )
    .get(msgId);
  if (existingApproval)
    return c.json({ error: "Already responded to this approval" }, 409);

  const approvalStatus = approved ? "approved" : "rejected";
  const created_at = new Date().toISOString();

  // Upsert approval_status
  db.run(
    `INSERT INTO approval_status (message_id, status, responder_soul_id, responder_identity, responded_at, comment)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(message_id) DO UPDATE SET
       status = excluded.status,
       responder_soul_id = excluded.responder_soul_id,
       responder_identity = excluded.responder_identity,
       responded_at = excluded.responded_at,
       comment = excluded.comment`,
    [msgId, approvalStatus, soul_id, identity, comment || ""]
  );

  // Also create an approval_response message for backward compat
  const responseId = randomUUID();
  const content = JSON.stringify({
    original_message_id: msgId,
    approved,
    comment: comment || "",
  });

  db.run(
    `INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content, created_at) VALUES (?, ?, ?, ?, 'approval_response', ?, ?)`,
    [responseId, channelId, soul_id, identity, content, created_at]
  );

  // Broadcast approval response via WebSocket
  connectionManager.broadcast(channelId, {
    type: "message",
    data: {
      id: responseId,
      channel_id: channelId,
      sender_soul_id: soul_id,
      sender_identity: identity,
      type: "approval_response",
      content,
      created_at,
    },
  });

  logAudit(soul_id, identity, approved ? "approve" : "reject", {
    channel_id: channelId,
    message_id: msgId,
    comment: comment || "",
  });

  return c.json({ id: responseId, approved, status: approvalStatus });
});

// Mark approval as timed out
app.post("/channels/:id/approvals/:msgId/timeout", async (c) => {
  const channelId = c.req.param("id");
  const msgId = c.req.param("msgId");

  const original = db
    .query(
      "SELECT * FROM messages WHERE id = ? AND channel_id = ? AND requires_approval = 1"
    )
    .get(msgId, channelId);
  if (!original)
    return c.json({ error: "Approval request not found" }, 404);

  // Check current status is pending
  const current = db
    .query("SELECT status FROM approval_status WHERE message_id = ?")
    .get(msgId) as { status: string } | null;
  if (current && current.status !== "pending")
    return c.json({ error: `Cannot timeout: status is ${current.status}` }, 409);

  db.run(
    `INSERT INTO approval_status (message_id, status, responded_at)
     VALUES (?, 'timed_out', datetime('now'))
     ON CONFLICT(message_id) DO UPDATE SET
       status = 'timed_out',
       responded_at = datetime('now')`,
    [msgId]
  );

  logAudit("SYSTEM", "System", "timeout", {
    channel_id: channelId,
    message_id: msgId,
  });

  return c.json({ message_id: msgId, status: "timed_out" });
});

// --- Audit API (Phase 3) ---

// List audit log entries
app.get("/audit", (c) => {
  const channel_id = c.req.query("channel_id");
  const actor = c.req.query("actor");
  const action = c.req.query("action");
  const since = c.req.query("since");
  const limit = parseInt(c.req.query("limit") || "100");

  let query = "SELECT * FROM audit_log WHERE 1=1";
  const params: any[] = [];

  if (channel_id) {
    query += " AND channel_id = ?";
    params.push(channel_id);
  }
  if (actor) {
    query += " AND actor_soul_id = ?";
    params.push(actor);
  }
  if (action) {
    query += " AND action = ?";
    params.push(action);
  }
  if (since) {
    query += " AND timestamp > ?";
    params.push(since);
  }

  query += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);

  const entries = db.query(query).all(...params);
  return c.json({ entries, count: entries.length });
});

// Audit summary
app.get("/audit/summary", (c) => {
  const channel_id = c.req.query("channel_id");
  const since = c.req.query("since");

  let whereClause = "WHERE 1=1";
  const params: any[] = [];

  if (channel_id) {
    whereClause += " AND channel_id = ?";
    params.push(channel_id);
  }
  if (since) {
    whereClause += " AND timestamp > ?";
    params.push(since);
  }

  const messagesByChannel = db
    .query(
      `SELECT channel_id, COUNT(*) as count FROM audit_log ${whereClause} AND action = 'send_message' GROUP BY channel_id`
    )
    .all(...params);

  const actionsByActor = db
    .query(
      `SELECT actor_soul_id, actor_identity, action, COUNT(*) as count FROM audit_log ${whereClause} GROUP BY actor_soul_id, action`
    )
    .all(...params);

  // Approval stats
  const approvalStats = db
    .query(
      `SELECT
         COUNT(CASE WHEN action = 'approve' THEN 1 END) as approved,
         COUNT(CASE WHEN action = 'reject' THEN 1 END) as rejected,
         COUNT(CASE WHEN action = 'timeout' THEN 1 END) as timed_out
       FROM audit_log ${whereClause}`
    )
    .get(...params) as any;

  const totalEntries = (
    db
      .query(`SELECT COUNT(*) as count FROM audit_log ${whereClause}`)
      .get(...params) as any
  ).count;

  const timeRange = db
    .query(
      `SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM audit_log ${whereClause}`
    )
    .get(...params) as any;

  return c.json({
    total_entries: totalEntries,
    messages_by_channel: messagesByChannel,
    actions_by_actor: actionsByActor,
    approval_stats: {
      approved: approvalStats?.approved || 0,
      rejected: approvalStats?.rejected || 0,
      timed_out: approvalStats?.timed_out || 0,
    },
    time_range: {
      earliest: timeRange?.earliest || null,
      latest: timeRange?.latest || null,
    },
  });
});

// --- Server export with WebSocket support ---

const PORT = parseInt(process.env.SOULTALK_PORT || "7777");
console.log(`SoulTalk server running on http://localhost:${PORT}`);
console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
console.log(`WebSocket: ws://localhost:${PORT}/ws?channel_id=xxx&soul_id=xxx`);

export default {
  port: PORT,
  fetch(req: Request, server: any) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/ws") {
      const data = validateUpgrade(req);
      if (!data) {
        return new Response("Unauthorized or invalid params", { status: 401 });
      }
      const upgraded = server.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Handle all other requests via Hono
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: any) {
      const data = ws.data as WSData;
      connectionManager.add(ws);

      // Send recent messages as initial payload
      const recent = getRecentMessages(data.channel_id, 10);
      ws.send(JSON.stringify({ type: "initial", data: recent }));
    },
    message(ws: any, msg: string | Buffer) {
      // Only expect pong from client
      try {
        const parsed = JSON.parse(typeof msg === "string" ? msg : msg.toString());
        if (parsed.type === "pong") {
          // Keepalive acknowledged
        }
      } catch {
        // Ignore malformed messages
      }
    },
    close(ws: any) {
      connectionManager.remove(ws);
    },
  },
};
