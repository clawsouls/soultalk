import db from "./db";
import { randomUUID } from "crypto";

export type AuditAction =
  | "send_message"
  | "join_channel"
  | "create_channel"
  | "approve"
  | "reject"
  | "timeout";

/**
 * Fire-and-forget audit logger. Non-blocking — errors are silently caught
 * so audit never slows down message delivery.
 */
export function logAudit(
  actor_soul_id: string,
  actor_identity: string,
  action: AuditAction,
  details: {
    channel_id?: string;
    message_id?: string;
    ip_address?: string;
    [key: string]: unknown;
  } = {}
): void {
  try {
    const { channel_id, message_id, ip_address, ...rest } = details;
    db.run(
      `INSERT INTO audit_log (id, actor_soul_id, actor_identity, action, channel_id, message_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        actor_soul_id,
        actor_identity,
        action,
        channel_id || null,
        message_id || null,
        JSON.stringify(rest),
        ip_address || "",
      ]
    );
  } catch {
    // Non-blocking: swallow errors so audit never disrupts operations
  }
}
