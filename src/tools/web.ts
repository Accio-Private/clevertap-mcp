import { z } from "zod";
import { chromium, type Browser, type BrowserContext } from "playwright";

// ── In-memory session store (keyed by project name) ──────────────────────────
// Holds the captured cookie string and CSRF token per project after web login.
interface WebSession {
  cookie: string;
  csrfToken: string;
  region: string;
  capturedAt: Date;
}

export const webSessions = new Map<string, WebSession>();

// Derive dashboard base URL from region
function dashboardUrl(region: string): string {
  return `https://${region}.dashboard.clevertap.com`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function extractSession(
  context: BrowserContext,
  region: string
): Promise<{ cookie: string; csrfToken: string } | null> {
  const origin = dashboardUrl(region);

  // Grab all cookies for the dashboard origin
  const cookies = await context.cookies(origin);
  if (cookies.length === 0) return null;

  const cookieHeader = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  // Look for CSRF token in cookies first (CleverTap typically stores it as a cookie)
  let csrfToken =
    cookies.find(
      (c) =>
        c.name.toLowerCase().includes("csrf") ||
        c.name.toLowerCase().includes("xsrf")
    )?.value ?? "";

  // If not found in cookies, try localStorage / sessionStorage via JS eval
  if (!csrfToken) {
    const page = context.pages()[0];
    if (page) {
      try {
        csrfToken = await page.evaluate(() => {
          return (
            (window as unknown as Record<string, unknown>)["_csrf"] as string ||
            sessionStorage.getItem("csrfToken") ||
            localStorage.getItem("csrfToken") ||
            ""
          );
        });
      } catch {
        // Page might be navigating; ignore
      }
    }
  }

  // Last resort: look for x-clevertap-csrf-token in ongoing network requests
  // (populated via the page's meta tag or inline script)
  if (!csrfToken) {
    const page = context.pages()[0];
    if (page) {
      try {
        csrfToken = await page.evaluate(() => {
          const meta = document.querySelector(
            'meta[name="csrf-token"], meta[name="_csrf"]'
          );
          return (meta as HTMLMetaElement)?.content ?? "";
        });
      } catch {
        // ignore
      }
    }
  }

  return { cookie: cookieHeader, csrfToken };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const webTools = [
  {
    name: "clevertap_web_login",
    description:
      "Open a Chromium browser window and navigate to the CleverTap dashboard login page. After you complete login (supports SSO and 2FA), the session cookie and CSRF token are captured automatically and stored for the project. Call clevertap_web_request afterwards to use them.",
    inputSchema: z.object({
      project: z
        .string()
        .optional()
        .describe(
          "Project name to associate this session with (must match a configured project name). Defaults to the first configured project."
        ),
      timeout_seconds: z
        .number()
        .min(30)
        .max(300)
        .default(120)
        .describe(
          "Seconds to wait for you to complete login before timing out (default 120)."
        ),
    }),
    handler: async (
      _client: unknown,
      args: unknown,
      meta: { projectNames: string[]; defaultProject: string; projectMeta: Map<string, { accountId: string; region: string }> }
    ) => {
      const { project: projectArg, timeout_seconds } = args as {
        project?: string;
        timeout_seconds: number;
      };

      const projectName = projectArg ?? meta.defaultProject;
      const projMeta = meta.projectMeta.get(projectName);
      if (!projMeta) {
        throw new Error(
          `Unknown project "${projectName}". Available: ${meta.projectNames.join(", ")}`
        );
      }

      const region = projMeta.region;
      const baseUrl = dashboardUrl(region);
      const loginUrl = `${baseUrl}/login`;

      let browser: Browser | undefined;
      try {
        browser = await chromium.launch({ headless: false });
        const context = await browser.newContext();
        const page = await context.newPage();

        // Intercept network requests to capture the CSRF header CleverTap sends
        let capturedCsrf = "";
        page.on("response", async (response) => {
          const csrf = response.headers()["x-clevertap-csrf-token"];
          if (csrf) capturedCsrf = csrf;
        });

        await page.goto(loginUrl, { waitUntil: "networkidle" });

        // Wait until the user lands on a page that is NOT the login page,
        // or until the timeout is reached.
        const deadline = Date.now() + timeout_seconds * 1000;
        let loggedIn = false;

        while (Date.now() < deadline) {
          await page.waitForTimeout(2000);
          const url = page.url();
          if (!url.includes("/login") && url.startsWith(baseUrl)) {
            loggedIn = true;
            break;
          }
        }

        if (!loggedIn) {
          await browser.close();
          return {
            content: [
              {
                type: "text" as const,
                text: `Timeout: login was not completed within ${timeout_seconds} seconds. Please try again.`,
              },
            ],
            isError: true,
          };
        }

        // Give the page a moment to finish loading post-login requests
        await page.waitForTimeout(2000);

        const sessionData = await extractSession(context, region);
        if (!sessionData || !sessionData.cookie) {
          await browser.close();
          return {
            content: [
              {
                type: "text" as const,
                text: "Login seemed successful but no session cookies were found. Try again.",
              },
            ],
            isError: true,
          };
        }

        // Prefer the CSRF token intercepted from response headers
        const csrfToken = capturedCsrf || sessionData.csrfToken;

        webSessions.set(projectName, {
          cookie: sessionData.cookie,
          csrfToken,
          region,
          capturedAt: new Date(),
        });

        await browser.close();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `✅ Web session captured for project "${projectName}"!`,
                "",
                `Dashboard  : ${baseUrl}`,
                `CSRF token : ${csrfToken ? csrfToken : "(not found — may not be needed)"}`,
                `Cookies    : ${sessionData.cookie.length} chars captured`,
                `Captured at: ${new Date().toISOString()}`,
                "",
                "You can now use clevertap_web_request to make dashboard API calls with these credentials.",
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        if (browser) {
          try { await browser.close(); } catch { /* ignore */ }
        }
        throw err;
      }
    },
  },

  {
    name: "clevertap_web_session_status",
    description:
      "Check whether a web session (cookie + CSRF token) has been captured for a project, and when it was obtained.",
    inputSchema: z.object({
      project: z
        .string()
        .optional()
        .describe("Project name to check (defaults to the first configured project)."),
    }),
    handler: async (
      _client: unknown,
      args: unknown,
      meta: { projectNames: string[]; defaultProject: string; projectMeta: Map<string, { accountId: string; region: string }> }
    ) => {
      const { project: projectArg } = args as { project?: string };
      const projectName = projectArg ?? meta.defaultProject;

      const session = webSessions.get(projectName);
      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No web session for project "${projectName}". Run clevertap_web_login first.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Web session for "${projectName}":`,
              `  Captured at : ${session.capturedAt.toISOString()}`,
              `  Region      : ${session.region}`,
              `  CSRF token  : ${session.csrfToken ? session.csrfToken : "(empty)"}`,
              `  Cookie size : ${session.cookie.length} chars`,
            ].join("\n"),
          },
        ],
      };
    },
  },

  {
    name: "clevertap_web_request",
    description:
      "Make an authenticated HTTP request to the CleverTap dashboard (web) API using the session cookie and CSRF token captured by clevertap_web_login. Use this for endpoints not available in the standard REST API.",
    inputSchema: z.object({
      path: z
        .string()
        .describe(
          'Dashboard API path, e.g. "/api/v1/some/endpoint". The base URL (https://{region}.dashboard.clevertap.com) is added automatically.'
        ),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE"])
        .default("GET")
        .describe("HTTP method"),
      body: z
        .preprocess(
          (v) => (typeof v === "string" ? JSON.parse(v) : v),
          z.record(z.unknown())
        )
        .optional()
        .describe("JSON request body for POST/PUT requests."),
      params: z
        .record(z.string())
        .optional()
        .describe("Query string parameters (key-value strings)."),
      project: z
        .string()
        .optional()
        .describe("Project name whose web session to use (defaults to first configured project)."),
    }),
    handler: async (
      _client: unknown,
      args: unknown,
      meta: { projectNames: string[]; defaultProject: string; projectMeta: Map<string, { accountId: string; region: string }> }
    ) => {
      const { path, method, body, params, project: projectArg } = args as {
        path: string;
        method: "GET" | "POST" | "PUT" | "DELETE";
        body?: Record<string, unknown>;
        params?: Record<string, string>;
        project?: string;
      };

      const projectName = projectArg ?? meta.defaultProject;
      const session = webSessions.get(projectName);

      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No web session for project "${projectName}". Run clevertap_web_login first.`,
            },
          ],
          isError: true,
        };
      }

      const baseUrl = dashboardUrl(session.region);
      const url = new URL(`${baseUrl}${path}`);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          url.searchParams.set(k, v);
        }
      }

      const headers: Record<string, string> = {
        "Cookie": session.cookie,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      };
      if (session.csrfToken) {
        headers["x-clevertap-csrf-token"] = session.csrfToken;
      }

      const response = await fetch(url.toString(), {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const responseText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = responseText;
      }

      if (!response.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `HTTP ${response.status} ${response.statusText}\n\n${typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2),
          },
        ],
      };
    },
  },

  {
    name: "clevertap_get_campaigns_ui",
    description:
      "List campaigns from the CleverTap dashboard (web UI API). Returns richer campaign data than the REST API: status, sent, impressions, clicks, engaged, edit URL, and more. Requires a web session — call clevertap_web_login first. Use this whenever the user asks about campaigns from the UI or dashboard.",
    inputSchema: z.object({
      stats_date_from: z
        .string()
        .regex(/^\d{8}$/)
        .describe("Stats date range start in YYYYMMDD format (e.g. 20260225)"),
      stats_date_to: z
        .string()
        .regex(/^\d{8}$/)
        .describe("Stats date range end in YYYYMMDD format (e.g. 20260327)"),
      date_from: z
        .string()
        .regex(/^\d{8}$/)
        .optional()
        .describe("Campaign creation date range start in YYYYMMDD format"),
      date_to: z
        .string()
        .regex(/^\d{8}$/)
        .optional()
        .describe("Campaign creation date range end in YYYYMMDD format"),
      search_keyword: z
        .string()
        .optional()
        .describe("Filter campaigns by name keyword"),
      archive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include archived campaigns (default false)"),
      status: z
        .array(z.string())
        .optional()
        .describe(
          'Filter by campaign status. Allowed values: "SCHEDULED", "RUNNING", "COMPLETED", "STOPPED", "DRAFT"'
        ),
      channel: z
        .array(z.number().int())
        .optional()
        .describe("Filter by channel codes (numeric)"),
      campaign_type: z
        .array(z.number().int())
        .optional()
        .describe(
          "Filter by campaign type codes (e.g. 2=push, 1=SMS, 3=in-app, 12=native display)"
        ),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(15)
        .describe("Number of results per page (default 15, max 100)"),
      page_number: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe("Page number starting from 1 (default 1)"),
      purpose: z
        .number()
        .int()
        .optional()
        .default(1)
        .describe("Campaign purpose filter (1 = regular campaigns, default 1)"),
      project: z
        .string()
        .optional()
        .describe(
          "Project name whose web session to use (defaults to first configured project)."
        ),
    }),
    handler: async (
      _client: unknown,
      args: unknown,
      meta: {
        projectNames: string[];
        defaultProject: string;
        projectMeta: Map<string, { accountId: string; region: string }>;
        webSessions: Map<string, WebSession>;
      }
    ) => {
      const {
        stats_date_from,
        stats_date_to,
        date_from,
        date_to,
        search_keyword,
        archive,
        status,
        channel,
        campaign_type,
        page_size,
        page_number,
        purpose,
        project: projectArg,
      } = args as {
        stats_date_from: string;
        stats_date_to: string;
        date_from?: string;
        date_to?: string;
        search_keyword?: string;
        archive?: boolean;
        status?: string[];
        channel?: number[];
        campaign_type?: number[];
        page_size?: number;
        page_number?: number;
        purpose?: number;
        project?: string;
      };

      const projectName = projectArg ?? meta.defaultProject;
      const session = webSessions.get(projectName);

      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No web session for project "${projectName}". Run clevertap_web_login first.`,
            },
          ],
          isError: true,
        };
      }

      const projMeta = meta.projectMeta.get(projectName);
      if (!projMeta) {
        throw new Error(`Unknown project "${projectName}".`);
      }

      const { accountId, region } = projMeta;
      const baseUrl = dashboardUrl(region);
      const effectivePageSize = page_size ?? 15;

      const q = {
        stc: 1,
        dateFrom: date_from ?? "",
        dateTo: date_to ?? "",
        statsDateFrom: stats_date_from,
        statsDateTo: stats_date_to,
        searchKeyword: search_keyword ?? "",
        archive: archive ?? false,
        prefiltered: null,
        purpose: purpose ?? 1,
        channel: channel ?? [],
        delivery: [],
        status: status ?? [],
        campaign_type: campaign_type ?? [],
        label: [],
        created_by: [],
        subChannel: [],
        externalCampaigns: [],
        pageSize: effectivePageSize,
        pageNumber: page_number ?? 1,
        name: "",
        dateRangeFilterOn: 0,
        isVNextListingRequest: true,
        totalCountLimit: 2001,
      };

      const url = new URL(`${baseUrl}/${accountId}/json/report/load`);
      url.searchParams.set("q", JSON.stringify(q));
      url.searchParams.set("source", "");
      url.searchParams.set("limit", String(effectivePageSize));
      url.searchParams.set("uc", "1");
      url.searchParams.set("requestTs", String(Date.now()));

      const headers: Record<string, string> = {
        Cookie: session.cookie,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en,es;q=0.9",
        Referer: `${baseUrl}/${accountId}/campaigns`,
      };
      if (session.csrfToken) {
        headers["x-clevertap-csrf-token"] = session.csrfToken;
      }

      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
      });

      const responseText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = responseText;
      }

      if (!response.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `HTTP ${response.status} ${response.statusText}\n\n${
                typeof parsed === "string"
                  ? parsed
                  : JSON.stringify(parsed, null, 2)
              }`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof parsed === "string"
                ? parsed
                : JSON.stringify(parsed, null, 2),
          },
        ],
      };
    },
  },

  {
    name: "clevertap_send_test_push",
    description:
      "Send a test push notification to a specific user via the CleverTap dashboard. Useful for previewing a push message on a real device. Requires a web session — call clevertap_web_login first. The user is identified by their CleverTap internal ID (iid / objectId). You can optionally provide device tokens per platform; if omitted the dashboard will use the tokens already registered for the user.",
    inputSchema: z.object({
      iid: z
        .string()
        .describe(
          "CleverTap internal user ID (objectId / iid), e.g. \"7760224\". Found in the profile view URL: /j{iid}/profile-view.html."
        ),
      title: z.string().describe("Push notification title"),
      message: z.string().describe("Push notification body text"),
      devices: z
        .enum(["ios", "android", "webpush", "all"])
        .default("all")
        .describe(
          "Target platform(s): \"ios\", \"android\", \"webpush\", or \"all\" (default)"
        ),
      device_token: z
        .string()
        .optional()
        .describe(
          "Device push token to use. If provided it is applied to all platform token fields (gcmIds, apnsTokens, chromeIds, etc.). If omitted an empty string is sent and the dashboard resolves the token from the user's profile."
        ),
      app_id: z
        .number()
        .int()
        .optional()
        .default(0)
        .describe("App ID (default 0)"),
      push_dispatcher_type: z
        .enum(["gcm", "apns", "hms"])
        .optional()
        .default("gcm")
        .describe("Push dispatcher type (default \"gcm\")"),
      wzrk_cid: z
        .string()
        .optional()
        .default("")
        .describe("Campaign ID for attribution (wzrk_cid, default empty)"),
      project: z
        .string()
        .optional()
        .describe(
          "Project name whose web session to use (defaults to first configured project)."
        ),
    }),
    handler: async (
      _client: unknown,
      args: unknown,
      meta: {
        projectNames: string[];
        defaultProject: string;
        projectMeta: Map<string, { accountId: string; region: string }>;
        webSessions: Map<string, WebSession>;
      }
    ) => {
      const {
        iid,
        title,
        message,
        devices,
        device_token,
        app_id,
        push_dispatcher_type,
        wzrk_cid,
        project: projectArg,
      } = args as {
        iid: string;
        title: string;
        message: string;
        devices: "ios" | "android" | "webpush" | "all";
        device_token?: string;
        app_id?: number;
        push_dispatcher_type?: string;
        wzrk_cid?: string;
        project?: string;
      };

      const projectName = projectArg ?? meta.defaultProject;
      const session = webSessions.get(projectName);

      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No web session for project "${projectName}". Run clevertap_web_login first.`,
            },
          ],
          isError: true,
        };
      }

      const projMeta = meta.projectMeta.get(projectName);
      if (!projMeta) {
        throw new Error(`Unknown project "${projectName}".`);
      }

      const { accountId, region } = projMeta;
      const baseUrl = dashboardUrl(region);

      // uids is the negative integer of the iid
      const uids = -Math.abs(parseInt(iid, 10));
      const token = device_token ?? "";

      const payload = {
        title,
        message,
        type: "uid",
        uids,
        iid,
        gcmIds: token,
        apnsTokens: token,
        winUris: token,
        chromeIds: token,
        firefoxIds: token,
        safariIds: token,
        kaiosIds: token,
        kv: {
          "1": { wzrk_cid: wzrk_cid ?? "", wzrk_bi: "2", wzrk_bc: "" },
          "2": {},
          "3": {},
        },
        appId: app_id ?? 0,
        usePushDispatcherType: push_dispatcher_type ?? "gcm",
      };

      const effectiveDevices = devices === "all" ? "android,ios,webpush" : devices;

      const url = new URL(
        `${baseUrl}/${accountId}/json/push/interact/previewTarget`
      );
      url.searchParams.set("devices", effectiveDevices);
      url.searchParams.set("globalCallback", "globalJsonPCallback");
      url.searchParams.set("requestTs", String(Date.now()));
      url.searchParams.set("dervied_page_name", "/profile-view.html");

      const headers: Record<string, string> = {
        Cookie: session.cookie,
        "Content-Type": "application/json; charset=UTF-8",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Origin: baseUrl,
        Referer: `${baseUrl}/${accountId}/j${iid}/profile-view.html`,
      };
      if (session.csrfToken) {
        headers["x-clevertap-csrf-token"] = session.csrfToken;
      }

      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = responseText;
      }

      if (!response.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `HTTP ${response.status} ${response.statusText}\n\n${
                typeof parsed === "string"
                  ? parsed
                  : JSON.stringify(parsed, null, 2)
              }`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof parsed === "string"
                ? parsed
                : JSON.stringify(parsed, null, 2),
          },
        ],
      };
    },
  },
];
