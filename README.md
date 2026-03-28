# clevertap-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [CleverTap](https://clevertap.com) REST API. Exposes CleverTap's user profiles, events, campaigns, and reports as tools that any MCP-compatible AI assistant (Claude, Cursor, etc.) can call directly.

---

## Features

- **Multi-project** — manage multiple CleverTap accounts from a single server instance
- **Guided setup** — if no project is configured, `clevertap_configure` walks you through the process
- **Full API coverage** — events, profiles, campaigns, and reports
- **Async polling** — long-running operations (event/profile counts) are polled automatically

---

## Tools

### Meta
| Tool | Description |
|------|-------------|
| `clevertap_configure` | Guided setup to add a project or generate the `CLEVERTAP_PROJECTS` config |
| `clevertap_list_projects` | List all configured projects and their regions |

### Events
| Tool | Description |
|------|-------------|
| `clevertap_upload_events` | Upload one or more events for a user |
| `clevertap_get_events` | Query event data with filters |
| `clevertap_get_events_cursor` | Fetch the next page of event results via cursor |
| `clevertap_get_event_count` | Get the total count of an event (with async polling) |

### Profiles
| Tool | Description |
|------|-------------|
| `clevertap_upload_profiles` | Create or update user profiles |
| `clevertap_get_profile` | Look up a single user by identity, email, or objectId |
| `clevertap_get_profiles_by_event` | Get profiles of users who performed an event |
| `clevertap_get_profiles_cursor` | Fetch the next page of profile results via cursor |
| `clevertap_delete_profile` | Delete a user profile |
| `clevertap_upload_device_token` | Register a push token for a user |
| `clevertap_get_profile_count` | Count profiles matching a segment |
| `clevertap_demerge_profiles` | Split merged profiles apart |
| `clevertap_subscribe` | Subscribe/unsubscribe a user to channels |
| `clevertap_disassociate_phone` | Remove a phone number from a profile |

### Campaigns
| Tool | Description |
|------|-------------|
| `clevertap_get_campaigns` | List campaigns within a date range |
| `clevertap_get_campaign_report` | Get delivery and engagement stats for a campaign |
| `clevertap_stop_campaign` | Stop a running campaign |
| `clevertap_create_campaign` | Create and launch a campaign |

### Reports
| Tool | Description |
|------|-------------|
| `clevertap_get_message_report` | Message-level delivery report |
| `clevertap_get_top_property_count` | Top property value counts for an event |
| `clevertap_get_event_trend` | Daily/weekly/monthly trend for an event |
| `clevertap_get_dau` | Daily active users trend |
| `clevertap_get_uninstall_report` | Uninstall trend report |
| `clevertap_get_real_time_counts` | Real-time active user counts |

### Generic
| Tool | Description |
|------|-------------|
| `clevertap_request` | Make any raw REST API request |
| `clevertap_poll` | Poll a pending async request by `req_id` |

---

## Installation

```bash
git clone https://github.com/your-org/clevertap-mcp.git
cd clevertap-mcp
npm install
npm run build
```

---

## Configuration

The server reads project credentials from the `CLEVERTAP_PROJECTS` environment variable — a JSON array of project objects:

```json
[
  {
    "name": "My App - Production",
    "account_id": "XXX-XXX-XXXX",
    "passcode": "YYY-YYY-YYYY",
    "region": "us1"
  },
  {
    "name": "My App - Staging",
    "account_id": "AAA-AAA-AAAA",
    "passcode": "BBB-BBB-BBBB",
    "region": "us1"
  }
]
```

**Supported regions:** `in1`, `us1`, `eu1`, `sg1`, `aps3`, `mec1`

### Single-project fallback

You can also use individual environment variables for a single project:

```bash
CLEVERTAP_ACCOUNT_ID=XXX-XXX-XXXX
CLEVERTAP_PASSCODE=YYY-YYY-YYYY
CLEVERTAP_REGION=us1
```

---

## Adding to Claude Desktop

In your `claude_desktop_config.json` (or `~/.claude.json`):

```json
{
  "mcpServers": {
    "clevertap": {
      "command": "node",
      "args": ["/absolute/path/to/clevertap-mcp/dist/index.js"],
      "env": {
        "CLEVERTAP_PROJECTS": "[{\"name\":\"My App\",\"account_id\":\"XXX-XXX-XXXX\",\"passcode\":\"YYY-YYY-YYYY\",\"region\":\"us1\"}]"
      }
    }
  }
}
```

> **Important:** `CLEVERTAP_PROJECTS` must be a serialized JSON **string** (not a native JSON object) inside the `env` block.

---

## Development

```bash
npm run build      # compile TypeScript → dist/
npm run dev        # watch mode
npm start          # run compiled server
```

### Project structure

```
src/
  index.ts          # MCP server entry point, project config, tool registration
  client.ts         # CleverTap REST API HTTP client
  tools/
    events.ts       # Event upload and query tools
    profiles.ts     # Profile management tools
    campaigns.ts    # Campaign tools
    reports.ts      # Analytics and report tools
    generic.ts      # Raw request / poll tools
    web.ts          # (future) Browser session tools via Playwright
```

---

## License

MIT
