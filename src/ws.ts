import type { ServerWebSocket } from "bun";
import db from "./db";

export interface WSData {
  channel_id: string;
  soul_id: string;
}

type WS = ServerWebSocket<WSData>;

export class ConnectionManager {
  private connections = new Map<string, Set<WS>>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Ping all connections every 30 seconds
    this.pingInterval = setInterval(() => {
      for (const [, sockets] of this.connections) {
        for (const ws of sockets) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }
    }, 30_000);
  }

  add(ws: WS): void {
    const { channel_id } = ws.data;
    if (!this.connections.has(channel_id)) {
      this.connections.set(channel_id, new Set());
    }
    this.connections.get(channel_id)!.add(ws);
  }

  remove(ws: WS): void {
    const { channel_id } = ws.data;
    const set = this.connections.get(channel_id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.connections.delete(channel_id);
      }
    }
  }

  broadcast(channelId: string, message: { type: string; data: unknown }): void {
    const set = this.connections.get(channelId);
    if (!set) return;
    const payload = JSON.stringify(message);
    for (const ws of set) {
      ws.send(payload);
    }
  }

  getConnectionCount(channelId?: string): number {
    if (channelId) {
      return this.connections.get(channelId)?.size ?? 0;
    }
    let total = 0;
    for (const [, set] of this.connections) {
      total += set.size;
    }
    return total;
  }

  destroy(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const [, sockets] of this.connections) {
      for (const ws of sockets) {
        ws.close(1001, "server shutting down");
      }
    }
    this.connections.clear();
  }
}

export const connectionManager = new ConnectionManager();

/** Validate a WebSocket upgrade request. Returns WSData or null. */
export function validateUpgrade(req: Request): WSData | null {
  const url = new URL(req.url);
  const channel_id = url.searchParams.get("channel_id");
  const soul_id = url.searchParams.get("soul_id");

  if (!channel_id || !soul_id) return null;

  // OBSERVER is a special soul_id for the dashboard (read-only, no membership required)
  if (soul_id === "OBSERVER") {
    // Just verify the channel exists
    const channel = db
      .query("SELECT id FROM channels WHERE id = ?")
      .get(channel_id);
    if (!channel) return null;
    return { channel_id, soul_id };
  }

  // Verify soul_id is member of channel
  const member = db
    .query("SELECT * FROM members WHERE channel_id = ? AND soul_id = ?")
    .get(channel_id, soul_id);

  if (!member) return null;

  return { channel_id, soul_id };
}

/** Get last N messages for a channel (for initial WS payload). */
export function getRecentMessages(channelId: string, limit = 10) {
  return db
    .query(
      "SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(channelId, limit)
    .reverse(); // chronological order
}
