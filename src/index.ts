#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CleverTapClient, CleverTapRegion } from "./client.js";
import { eventTools } from "./tools/events.js";
import { profileTools } from "./tools/profiles.js";
import { campaignTools } from "./tools/campaigns.js";
import { reportTools } from "./tools/reports.js";
import { genericTools } from "./tools/generic.js";
// import { webTools, webSessions } from "./tools/web.js"; // TODO: next version

// --- Build projects map ---
// CLEVERTAP_PROJECTS accepts a JSON array:
// [ { "name": "prod", "account_id": "...", "passcode": "...", "region": "us1" }, ... ]
// Falls back to single project via CLEVERTAP_ACCOUNT_ID / CLEVERTAP_PASSCODE / CLEVERTAP_REGION.

const clients = new Map<string, CleverTapClient>();
const projectMeta = new Map<string, { accountId: string; region: string }>();

const projectsEnv = process.env.CLEVERTAP_PROJECTS;
if (projectsEnv) {
  let projectsConfig: Array<{ name: string; account_id: string; passcode: string; region?: string }>;
  try {
    projectsConfig = JSON.parse(projectsEnv);
  } catch {
    console.error("Error: CLEVERTAP_PROJECTS is not valid JSON.");
    process.exit(1);
  }
  if (!Array.isArray(projectsConfig)) {
    console.error("Error: CLEVERTAP_PROJECTS must be a JSON array.");
    process.exit(1);
  }
  for (const cfg of projectsConfig) {
    if (!cfg.name || !cfg.account_id || !cfg.passcode) {
      console.error(`Error: Every project entry must have name, account_id, and passcode.`);
      process.exit(1);
    }
    const region = (cfg.region ?? "in1") as CleverTapRegion;
    clients.set(cfg.name, new CleverTapClient({ accountId: cfg.account_id, passcode: cfg.passcode, region }));
    projectMeta.set(cfg.name, { accountId: cfg.account_id, region });
  }
} else {
  // Legacy single-project mode
  const accountId = process.env.CLEVERTAP_ACCOUNT_ID;
  const passcode = process.env.CLEVERTAP_PASSCODE;
  const region = (process.env.CLEVERTAP_REGION ?? "in1") as CleverTapRegion;
  if (accountId && passcode) {
    clients.set("default", new CleverTapClient({ accountId, passcode, region }));
    projectMeta.set("default", { accountId, region });
  }
  // If neither is set, fall through to the setup tool registration below.
}

const projectNames = Array.from(clients.keys());
const defaultProject = projectNames[0];

// --- Server ---
const server = new McpServer({
  name: "clevertap-mcp",
  version: "1.0.0",
});

const allTools = [...eventTools, ...profileTools, ...campaignTools, ...reportTools, ...genericTools];

if (clients.size === 0) {
  // ── No project configured — register a guided setup tool ──────────────────
  console.error(
    "CleverTap MCP: no project configured. Register the clevertap_configure tool to guide setup."
  );

  const setupSchema = z.object({
    account_id: z
      .string()
      .describe(
        "CleverTap Account ID — found in the CleverTap dashboard under Settings → Accounts"
      ),
    passcode: z
      .string()
      .describe(
        "CleverTap Passcode — found in the CleverTap dashboard under Settings → Accounts"
      ),
    region: z
      .enum(["in1", "us1", "eu1", "sg1", "aps3", "mec1"])
      .default("in1")
      .describe(
        "Data residency region: in1 (India), us1 (US), eu1 (Europe), sg1 (Singapore), aps3 (Asia-Pacific), mec1 (Middle East)"
      ),
    project_name: z
      .string()
      .default("default")
      .describe(
        'Label for this project. Use any short name (e.g. "production", "staging"). Defaults to "default".'
      ),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(
    "clevertap_configure",
    "CleverTap MCP has no project configured yet. Call this tool with your CleverTap credentials and it will return the exact configuration snippet to paste into your MCP settings — then restart the server to activate all tools.",
    setupSchema.shape as any,
    async (args: unknown) => {
      const { account_id, passcode, region, project_name } = args as {
        account_id: string;
        passcode: string;
        region: string;
        project_name: string;
      };

      const singleVars = [
        `CLEVERTAP_ACCOUNT_ID=${account_id}`,
        `CLEVERTAP_PASSCODE=${passcode}`,
        `CLEVERTAP_REGION=${region}`,
      ].join("\n");

      const multiArray = [{ name: project_name, account_id, passcode, region }];
      const multiJson = JSON.stringify(multiArray, null, 2);
      const multiInline = JSON.stringify(multiArray);

      const text = [
        "✅ Credentials received!",
        "",
        "Choose one of the two options below, add it to your MCP server config, then restart the server.",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Option A — Individual env variables (single project)",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        singleVars,
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Option B — CLEVERTAP_PROJECTS (supports multiple projects)",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        `CLEVERTAP_PROJECTS=${multiInline}`,
        "",
        "Pretty-printed for reference:",
        multiJson,
        "",
        "After saving the env variables, restart the MCP server. All CleverTap tools will be available once it reconnects.",
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );
} else {
  // ── Projects configured — register all normal tools ────────────────────────

  // List projects tool
  server.tool(
    "clevertap_list_projects",
    "List all CleverTap projects currently configured in this MCP server, showing each project name, account ID, and region.",
    {},
    async () => {
      const rows = Array.from(projectMeta.entries()).map(([name, meta], i) => {
        const isDefault = name === defaultProject;
        return `${i + 1}. ${name}${isDefault ? " (default)" : ""}\n   Account ID : ${meta.accountId}\n   Region     : ${meta.region}`;
      });
      const text = [
        `Configured projects (${projectMeta.size}):`,
        "",
        ...rows,
        "",
        'To target a specific project in any tool, pass  "project": "<name>".',
        `If omitted, the default project "${defaultProject}" is used.`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // Configure / add-project tool (also available when projects are configured)
  const setupSchema = z.object({
    account_id: z
      .string()
      .describe(
        "CleverTap Account ID — found in the CleverTap dashboard under Settings → Accounts"
      ),
    passcode: z
      .string()
      .describe(
        "CleverTap Passcode — found in the CleverTap dashboard under Settings → Accounts"
      ),
    region: z
      .enum(["in1", "us1", "eu1", "sg1", "aps3", "mec1"])
      .default("in1")
      .describe(
        "Data residency region: in1 (India), us1 (US), eu1 (Europe), sg1 (Singapore), aps3 (Asia-Pacific), mec1 (Middle East)"
      ),
    project_name: z
      .string()
      .default("default")
      .describe(
        'Label for this project (e.g. "production", "staging"). Must be unique.'
      ),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(
    "clevertap_configure",
    "Add a new CleverTap project to this MCP server. Returns the updated CLEVERTAP_PROJECTS JSON to paste into your MCP settings — restart the server to apply.",
    setupSchema.shape as any,
    async (args: unknown) => {
      const { account_id, passcode, region, project_name } = args as {
        account_id: string;
        passcode: string;
        region: string;
        project_name: string;
      };

      // Build a merged array that includes existing projects + the new one
      const merged: Array<{ name: string; account_id: string; passcode: string; region: string }> = [];
      for (const [name, meta] of projectMeta.entries()) {
        // We don't store passcodes in memory — placeholder so the user knows to keep them
        merged.push({ name, account_id: meta.accountId, passcode: "<keep-existing-passcode>", region: meta.region });
      }
      merged.push({ name: project_name, account_id, passcode, region });

      const mergedInline = JSON.stringify(merged);
      const mergedPretty = JSON.stringify(merged, null, 2);

      const text = [
        `✅ Project "${project_name}" ready!`,
        "",
        "Update your MCP config with the following env variable (replaces any existing CLEVERTAP_PROJECTS).",
        "Fill in the real passcodes for existing projects where shown as <keep-existing-passcode>.",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "CLEVERTAP_PROJECTS (all projects, multi-project mode)",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        `CLEVERTAP_PROJECTS=${mergedInline}`,
        "",
        "Pretty-printed for reference:",
        mergedPretty,
        "",
        "After updating the config, restart the MCP server to activate the new project.",
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );

  for (const tool of allTools) {
    // Extend every tool's schema with an optional `project` field
    const extendedSchema = tool.inputSchema.extend({
      project: z
        .enum(projectNames as [string, ...string[]])
        .optional()
        .describe(
          `CleverTap project to use. Available: ${projectNames.join(", ")}. Defaults to "${defaultProject}".`
        ),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.tool(tool.name, tool.description, extendedSchema.shape as any, async (args: unknown) => {
      const { project: projectArg, ...toolArgs } = args as Record<string, unknown> & { project?: string };
      const projectName = projectArg ?? defaultProject;
      const client = clients.get(projectName);

      if (!client) {
        return {
          content: [{ type: "text" as const, text: `Error: Unknown project "${projectName}". Available: ${projectNames.join(", ")}` }],
          isError: true,
        };
      }

      try {
        const result = await tool.handler(client, toolArgs);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  // ── Web (browser) tools — TODO: next version ──
  // const webMeta = { projectNames, defaultProject, projectMeta, webSessions };
  // for (const tool of webTools) {
  //   server.tool(tool.name, tool.description, tool.inputSchema.shape as any, async (args: unknown) => {
  //     try {
  //       const result = await (tool.handler as any)(null, args, webMeta);
  //       return result;
  //     } catch (error) {
  //       const message = error instanceof Error ? error.message : String(error);
  //       return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  //     }
  //   });
  // }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`CleverTap MCP server running — projects: ${projectNames.join(", ")}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
