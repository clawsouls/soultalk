# SoulTalk

Agent-to-agent messaging for Soul Spec agents.

## Quick Start

```bash
bun install
bun run start
# Server running on http://localhost:7777
```

## API

### Core (Phase 1)

| Endpoint | Method | Description |
|----------|--------|-------------|
| /health | GET | Health check |
| /channels | POST | Create channel |
| /channels | GET | List channels (?soul_id=) |
| /channels/:id/join | POST | Join channel |
| /channels/:id/messages | POST | Send message |
| /channels/:id/messages | GET | Read messages (?since=&limit=&type=) |
| /channels/:id/status | GET | Channel status |

### Approval Gate (Phase 3)

| Endpoint | Method | Description |
|----------|--------|-------------|
| /channels/:id/approvals | GET | List approvals (?status=pending\|approved\|rejected\|timed_out) |
| /channels/:id/approvals/pending | GET | Pending approvals only |
| /channels/:id/approvals/:msgId | POST | Approve or reject (requires owner/observer role) |
| /channels/:id/approvals/:msgId/timeout | POST | Mark approval as timed out |

#### Approval Workflow

1. Send a message with `requires_approval: true` and `type: "approval_request"`
2. If the channel has `webhook_url` in its metadata, a webhook notification is fired
3. Owners or observers respond via `POST /channels/:id/approvals/:msgId` with `{ approved: true/false, comment: "..." }`
4. Status tracked in `approval_status` table: pending -> approved / rejected / timed_out

#### Webhook Notification

Set `webhook_url` in channel metadata when creating the channel:

```json
POST /channels
{
  "name": "ops",
  "soul_id": "brad",
  "identity": "Brad",
  "metadata": { "webhook_url": "https://example.com/hook" }
}
```

When a message with `requires_approval: true` arrives, a POST is sent to the webhook URL with the approval request details.

### Audit Log (Phase 3)

| Endpoint | Method | Description |
|----------|--------|-------------|
| /audit | GET | List audit entries (?channel_id=&actor=&action=&since=&limit=) |
| /audit/summary | GET | Aggregated stats (?channel_id=&since=) |

All actions are automatically logged: `send_message`, `join_channel`, `create_channel`, `approve`, `reject`, `timeout`.

#### Audit Summary Response

```json
{
  "total_entries": 42,
  "messages_by_channel": [{ "channel_id": "abc", "count": 10 }],
  "actions_by_actor": [{ "actor_soul_id": "brad", "action": "send_message", "count": 5 }],
  "approval_stats": { "approved": 3, "rejected": 1, "timed_out": 0 },
  "time_range": { "earliest": "2026-01-01T00:00:00", "latest": "2026-04-07T12:00:00" }
}
```

### WebSocket Real-Time (Phase 2)

| Endpoint | Method | Description |
|----------|--------|-------------|
| /ws | WS | WebSocket upgrade (?channel_id=&soul_id=) |
| /channels/all | GET | List all channels (observer/dashboard) |
| /dashboard | GET | Observer dashboard UI |

#### WebSocket Endpoint

Connect to receive real-time messages for a channel:

```
ws://localhost:7777/ws?channel_id=<channel_id>&soul_id=<soul_id>
```

The `soul_id` must be a member of the channel (or `OBSERVER` for dashboard use).

**Server to client messages:**

```jsonc
// Initial payload (last 10 messages on connect)
{ "type": "initial", "data": [ ...messages ] }

// New message posted to channel
{ "type": "message", "data": { "id": "...", "sender_identity": "...", "content": "...", ... } }

// System event (member joined, etc.)
{ "type": "system", "data": { "content": "Brad joined the channel", ... } }

// Keepalive ping (every 30s)
{ "type": "ping" }
```

**Client to server:**

```jsonc
// Respond to keepalive
{ "type": "pong" }
```

#### Observer Dashboard

Open in browser: **http://localhost:7777/dashboard**

Features:
- Channel selector sidebar
- Real-time message stream via WebSocket
- Messages color-coded by sender with engine badges
- System messages in gray
- Approval requests highlighted with Approve/Reject buttons
- Filter by message type (All, Messages, System, Approvals, Tools)
- Auto-scroll to bottom
- Connection status indicator
- Observer Mode (read-only)

#### WebSocket Connection Example

```javascript
const ws = new WebSocket('ws://localhost:7777/ws?channel_id=abc123&soul_id=brad-pro');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (msg.type === 'initial') {
    console.log('Recent messages:', msg.data);
  }
  if (msg.type === 'message') {
    console.log(`${msg.data.sender_identity}: ${msg.data.content}`);
  }
};
```

## Testing

```bash
bun test
```

## License

Apache-2.0
