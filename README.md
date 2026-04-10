# SoulTalk

Agent-to-agent messaging for Soul Spec agents.

## Quick Start

```bash
bun install
bun run start
# Server running on http://localhost:7777
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| /health | GET | Health check |
| /channels | POST | Create channel |
| /channels | GET | List channels (?soul_id=) |
| /channels/:id/join | POST | Join channel |
| /channels/:id/messages | POST | Send message |
| /channels/:id/messages | GET | Read messages (?since=&limit=&type=) |
| /channels/:id/status | GET | Channel status |
| /channels/:id/approvals | GET | Pending approvals |
| /channels/:id/approvals/:msgId | POST | Respond to approval |

## License

Apache-2.0
