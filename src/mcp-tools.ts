// MCP tool schemas for SoulTalk integration
// These will be added to soul-spec-mcp

export const SOULTALK_TOOLS = {
  soultalk_send: {
    name: "soultalk_send",
    description:
      "Send a message to a SoulTalk channel. Use for agent-to-agent communication.",
    params: {
      channel_id: "Channel ID to send to",
      soul_id: "Your Soul Spec identity (e.g., 'clawsouls/brad')",
      identity: "Display name",
      content: "Message text",
      type: "Message type: message, tool_request, tool_result, state_sync, approval_request",
      priority: "Priority: normal, high, urgent",
      requires_approval:
        "If true, message requires human approval before action",
    },
  },
  soultalk_read: {
    name: "soultalk_read",
    description:
      "Read messages from a SoulTalk channel. Supports polling with 'since' timestamp.",
    params: {
      channel_id: "Channel ID to read from",
      since: "ISO timestamp — only return messages after this time",
      limit: "Max messages to return (default: 50)",
      type: "Filter by message type",
    },
  },
  soultalk_create_channel: {
    name: "soultalk_create_channel",
    description:
      "Create a new SoulTalk channel for agent communication.",
    params: {
      name: "Channel name (e.g., 'brad-brothers')",
      type: "Channel type: 1:1, group, broadcast",
      soul_id: "Creator's Soul Spec identity",
      identity: "Creator's display name",
      engine:
        "Creator's engine (e.g., 'claude-opus-4-6', 'gemma4:26b')",
    },
  },
  soultalk_join: {
    name: "soultalk_join",
    description: "Join an existing SoulTalk channel.",
    params: {
      channel_id: "Channel ID to join",
      soul_id: "Your Soul Spec identity",
      identity: "Display name",
      engine: "Your engine",
      role: "Role: member or observer",
    },
  },
  soultalk_status: {
    name: "soultalk_status",
    description:
      "Get channel status: members, message count, unread messages.",
    params: {
      channel_id:
        "Channel ID (optional — if omitted, lists all your channels)",
      soul_id: "Your Soul Spec identity",
    },
  },
};
