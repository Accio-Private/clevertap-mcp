#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express from "express";
import cookieParser from "cookie-parser";
import { RedisOAuthStore } from "./auth/redis-store.js";
import { JwtService } from "./auth/jwt-service.js";
import {
  GoogleOAuthProvider,
  OAUTH_SESSION_COOKIE,
} from "./auth/google-provider.js";
import { z } from "zod";
import { CleverTapClient, CleverTapRegion } from "./client.js";
import { eventTools } from "./tools/events.js";
import { profileTools } from "./tools/profiles.js";
import { campaignTools } from "./tools/campaigns.js";
import { reportTools } from "./tools/reports.js";
import { genericTools } from "./tools/generic.js";
import { webTools, webSessions } from "./tools/web.js";

// --- Build projects map ---
// CLEVERTAP_PROJECTS accepts a JSON array:
// [ { "name": "prod", "account_id": "...", "passcode": "...", "region": "us1" }, ... ]

const clients = new Map<string, CleverTapClient>();
const projectMeta = new Map<string, { accountId: string; region: string }>();

const projectsEnv = process.env.CLEVERTAP_PROJECTS;
if (projectsEnv) {
  let projectsConfig: Array<{
    name: string;
    account_id: string;
    passcode: string;
    region?: string;
  }>;
  try {
    projectsConfig = JSON.parse(projectsEnv);
  } catch (e) {
    console.error(
      `Error: CLEVERTAP_PROJECTS is not valid JSON. Actual value is: ${projectsEnv}`,
      e,
    );
    process.exit(1);
  }
  if (!Array.isArray(projectsConfig)) {
    console.error("Error: CLEVERTAP_PROJECTS must be a JSON array.");
    process.exit(1);
  }
  for (const cfg of projectsConfig) {
    if (!cfg.name || !cfg.account_id || !cfg.passcode) {
      console.error(
        `Error: Every project entry must have name, account_id, and passcode.`,
      );
      process.exit(1);
    }
    const region = (cfg.region ?? "in1") as CleverTapRegion;
    clients.set(
      cfg.name,
      new CleverTapClient({
        accountId: cfg.account_id,
        passcode: cfg.passcode,
        region,
      }),
    );
    projectMeta.set(cfg.name, { accountId: cfg.account_id, region });
  }
}

const projectNames = Array.from(clients.keys());
const defaultProject = projectNames[0];

// --- Server ---
const server = new McpServer({
  name: "clevertap-mcp",
  version: "1.0.0",
});

const allTools = [
  ...eventTools,
  ...profileTools,
  ...campaignTools,
  ...reportTools,
  ...genericTools,
];

for (const tool of allTools) {
  // Extend every tool's schema with an optional `project` field
  const extendedSchema = tool.inputSchema.extend({
    project: z
      .enum(projectNames as [string, ...string[]])
      .optional()
      .describe(
        `CleverTap project to use. Available: ${projectNames.join(", ")}. Defaults to "${defaultProject}".`,
      ),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(
    tool.name,
    tool.description,
    extendedSchema.shape as any,
    async (args: unknown) => {
      const { project: projectArg, ...toolArgs } = args as Record<
        string,
        unknown
      > & { project?: string };
      const projectName = projectArg ?? defaultProject;
      const client = clients.get(projectName);

      if (!client) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Unknown project "${projectName}". Available: ${projectNames.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await tool.handler(client, toolArgs);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

// ── Web (browser) tools ──────────────────────────────────────────────────────
const webMeta = { projectNames, defaultProject, projectMeta, webSessions };
for (const tool of webTools) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape as any,
    async (args: unknown) => {
      try {
        const result = await (tool.handler as any)(null, args, webMeta);
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

async function main() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  await server.connect(transport);

  const PORT = parseInt(process.env.PORT ?? "3000", 10);
  const app = express();

  // Trust reverse proxy so OAuth redirects use the correct https:// scheme
  app.set("trust proxy", 1);

  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, mcp-session-id",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, DELETE, OPTIONS",
    );
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

  // ── Health check (required for AWS App Runner and similar platforms) ──────────
  app.get("/", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  // ── OAuth (only when all four env vars are present) ───────────────────────────
  const oauthEnabled =
    !!process.env.MCP_JWT_SECRET &&
    !!process.env.GOOGLE_CLIENT_ID &&
    !!process.env.GOOGLE_CLIENT_SECRET &&
    !!process.env.REDIS_HOST;

  console.error(
    `[DEBUG][auth] OAuth env check — MCP_JWT_SECRET: ${!!process.env.MCP_JWT_SECRET}, GOOGLE_CLIENT_ID: ${!!process.env.GOOGLE_CLIENT_ID}, GOOGLE_CLIENT_SECRET: ${!!process.env.GOOGLE_CLIENT_SECRET}, REDIS_HOST: ${!!process.env.REDIS_HOST} → oauthEnabled: ${oauthEnabled}`,
  );

  if (oauthEnabled) {
    const serverUrl =
      process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}`;
    const resourceUrl = `${serverUrl}/mcp`;

    const redisStore = new RedisOAuthStore(
      process.env.REDIS_HOST!,
      parseInt(process.env.REDIS_PORT ?? "6379", 10),
    );
    const jwtService = new JwtService(
      process.env.MCP_JWT_SECRET!,
      serverUrl,
    );
    const provider = new GoogleOAuthProvider(
      redisStore,
      jwtService,
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      serverUrl,
      resourceUrl,
    );

    // Standard MCP OAuth endpoints + .well-known metadata
    // Log all OAuth flow requests to surface failures in /authorize, /token, /register
    app.use((req, _res, next) => {
      const oauthPaths = ["/authorize", "/token", "/register", "/revoke", "/.well-known"];
      if (oauthPaths.some(p => req.path.startsWith(p))) {
        console.error(`[DEBUG][oauth] ${req.method} ${req.path} — body keys: ${Object.keys(req.body ?? {}).join(", ") || "(none)"}`);
      }
      next();
    });
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(serverUrl),
        resourceServerUrl: new URL(resourceUrl),
      }),
    );

    // Google OAuth callback — not part of the standard MCP OAuth router
    app.get("/auth/callback", async (req, res) => {
      const { code, state } = req.query as {
        code?: string;
        state?: string;
      };
      const cookieSessionId = (req.cookies as Record<string, string>)[
        OAUTH_SESSION_COOKIE
      ];

      console.error(`[DEBUG][oauth] /auth/callback — code: ${!!code}, state: ${!!state}, cookieSessionId: ${!!cookieSessionId}, stateMatch: ${state === cookieSessionId}`);

      if (!code || !state || state !== cookieSessionId) {
        console.error(`[DEBUG][oauth] /auth/callback rejected — code: ${!!code}, state: ${!!state}, cookieMatch: ${state === cookieSessionId}`);
        res.status(400).send("Invalid OAuth callback: state mismatch or missing code");
        return;
      }

      try {
        const redirectUrl = await provider.handleGoogleCallback(code, state);
        console.error(`[DEBUG][oauth] /auth/callback success — redirecting to: ${redirectUrl.split("?")[0]}...`);
        res.clearCookie(OAUTH_SESSION_COOKIE);
        res.redirect(redirectUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[OAuth callback] ERROR:", message);
        res.status(500).send(`OAuth callback failed: ${message}`);
      }
    });

    // MCP endpoint — protected by Bearer token
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
      new URL(resourceUrl),
    );
    const bearerAuth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl,
    });

    app.use("/mcp", (req, _res, next) => {
      const authHeader = req.headers["authorization"];
      if (authHeader) {
        const prefix = authHeader.slice(0, 30);
        console.error(`[DEBUG][auth] /mcp request — Authorization header present (prefix: "${prefix}...")`);
      } else {
        console.error(`[DEBUG][auth] /mcp request — Authorization header MISSING`);
      }
      next();
    }, bearerAuth, (req, res, next) => {
      transport.handleRequest(req, res, req.body).catch(next);
    });

    console.error(
      `CleverTap MCP server listening on http://0.0.0.0:${PORT} — OAuth enabled, MCP at /mcp — projects: ${projectNames.join(", ")}`,
    );
  } else {
    // No OAuth — serve /mcp without authentication (local / stdio use)
    app.use("/mcp", (req, res, next) => {
      transport.handleRequest(req, res, req.body).catch(next);
    });

    if (
      process.env.GOOGLE_CLIENT_ID ||
      process.env.MCP_JWT_SECRET ||
      process.env.REDIS_HOST
    ) {
      console.error(
        "CleverTap MCP: OAuth partially configured. Set MCP_JWT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and REDIS_HOST to enable OAuth.",
      );
    }

    console.error(
      `CleverTap MCP server listening on http://0.0.0.0:${PORT} — no auth, MCP at /mcp — projects: ${projectNames.join(", ")}`,
    );
  }

  app.listen(PORT, "0.0.0.0");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
