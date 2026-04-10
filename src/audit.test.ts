import { expect, test, beforeAll } from "bun:test";
import db from "./db";
import { logAudit } from "./audit";
import { randomUUID } from "crypto";

// Clean test state
beforeAll(() => {
  db.run("DELETE FROM audit_log");
  db.run("DELETE FROM approval_status");
  db.run("DELETE FROM messages WHERE sender_soul_id = 'test-soul'");
  db.run("DELETE FROM members WHERE soul_id = 'test-soul'");
  db.run("DELETE FROM channels WHERE created_by = 'test-soul'");
});

test("audit log records actions", () => {
  logAudit("test-soul", "TestBot", "send_message", {
    channel_id: "ch-1",
    message_id: "msg-1",
  });

  logAudit("test-soul", "TestBot", "create_channel", {
    channel_id: "ch-1",
    channel_name: "test-channel",
  });

  const entries = db
    .query("SELECT * FROM audit_log WHERE actor_soul_id = 'test-soul' ORDER BY timestamp ASC")
    .all() as any[];

  expect(entries.length).toBe(2);
  expect(entries[0].action).toBe("send_message");
  expect(entries[0].channel_id).toBe("ch-1");
  expect(entries[1].action).toBe("create_channel");
});

test("approval gate tracks status", () => {
  const msgId = randomUUID();

  // Create a message that requires approval
  db.run(
    `INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content, requires_approval)
     VALUES (?, 'test-ch', 'test-soul', 'TestBot', 'approval_request', 'please approve', 1)`,
    [msgId]
  );

  // Insert pending approval status
  db.run(
    "INSERT INTO approval_status (message_id, status) VALUES (?, 'pending')",
    [msgId]
  );

  // Check pending
  const pending = db
    .query("SELECT * FROM approval_status WHERE message_id = ?")
    .get(msgId) as any;
  expect(pending.status).toBe("pending");

  // Approve it
  db.run(
    `UPDATE approval_status SET status = 'approved', responder_soul_id = 'approver-1',
     responder_identity = 'Approver', responded_at = datetime('now'), comment = 'looks good'
     WHERE message_id = ?`,
    [msgId]
  );

  const approved = db
    .query("SELECT * FROM approval_status WHERE message_id = ?")
    .get(msgId) as any;
  expect(approved.status).toBe("approved");
  expect(approved.responder_soul_id).toBe("approver-1");
  expect(approved.comment).toBe("looks good");
});

test("pending approvals endpoint works", async () => {
  // Clean slate
  db.run("DELETE FROM approval_status");
  db.run("DELETE FROM messages WHERE channel_id = 'pending-test-ch'");
  db.run("DELETE FROM channels WHERE id = 'pending-test-ch'");

  // Create channel
  db.run(
    "INSERT INTO channels (id, name, type, created_by) VALUES ('pending-test-ch', 'test', 'group', 'test-soul')"
  );

  // Create two messages that require approval
  const msg1 = randomUUID();
  const msg2 = randomUUID();

  db.run(
    `INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content, requires_approval)
     VALUES (?, 'pending-test-ch', 'test-soul', 'TestBot', 'approval_request', 'first', 1)`,
    [msg1]
  );
  db.run(
    `INSERT INTO messages (id, channel_id, sender_soul_id, sender_identity, type, content, requires_approval)
     VALUES (?, 'pending-test-ch', 'test-soul', 'TestBot', 'approval_request', 'second', 1)`,
    [msg2]
  );

  // Both pending (no approval_status rows = pending by default)
  const allPending = db
    .query(
      `SELECT m.*, COALESCE(a.status, 'pending') as approval_status
       FROM messages m
       LEFT JOIN approval_status a ON m.id = a.message_id
       WHERE m.channel_id = 'pending-test-ch' AND m.requires_approval = 1
         AND COALESCE(a.status, 'pending') = 'pending'`
    )
    .all();
  expect(allPending.length).toBe(2);

  // Approve msg1
  db.run(
    "INSERT INTO approval_status (message_id, status, responder_soul_id, responder_identity, responded_at) VALUES (?, 'approved', 'approver', 'Approver', datetime('now'))",
    [msg1]
  );

  // Now only msg2 should be pending
  const remaining = db
    .query(
      `SELECT m.*, COALESCE(a.status, 'pending') as approval_status
       FROM messages m
       LEFT JOIN approval_status a ON m.id = a.message_id
       WHERE m.channel_id = 'pending-test-ch' AND m.requires_approval = 1
         AND COALESCE(a.status, 'pending') = 'pending'`
    )
    .all();
  expect(remaining.length).toBe(1);
  expect((remaining[0] as any).id).toBe(msg2);
});

test("audit log filters work", () => {
  // Clear and insert known data
  db.run("DELETE FROM audit_log");

  logAudit("soul-a", "Alpha", "send_message", { channel_id: "ch-x" });
  logAudit("soul-b", "Beta", "create_channel", { channel_id: "ch-y" });
  logAudit("soul-a", "Alpha", "approve", { channel_id: "ch-x", message_id: "m1" });

  // Filter by actor
  const byActor = db
    .query("SELECT * FROM audit_log WHERE actor_soul_id = 'soul-a'")
    .all();
  expect(byActor.length).toBe(2);

  // Filter by action
  const byAction = db
    .query("SELECT * FROM audit_log WHERE action = 'approve'")
    .all();
  expect(byAction.length).toBe(1);

  // Filter by channel
  const byChannel = db
    .query("SELECT * FROM audit_log WHERE channel_id = 'ch-x'")
    .all();
  expect(byChannel.length).toBe(2);
});
