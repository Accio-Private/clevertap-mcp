import { z } from "zod";
import { chromium, type Browser, type BrowserContext } from "playwright";

// ── In-memory session store (keyed by project name) ──────────────────────────
// Holds the captured cookie string and CSRF token per project after web login.
interface WebSession {
  cookie: string;
  csrfToken: string;
  region: string;
  capturedAt: Date;
  atcExpiresAt?: Date; // parsed from the at_c JWT exp claim
}

export const webSessions = new Map<string, WebSession>();

// Derive dashboard base URL from region
function dashboardUrl(region: string): string {
  return `https://${region}.dashboard.clevertap.com`;
}

// Strip the "TEST-" prefix that CleverTap uses in REST API account IDs
// but not in dashboard UI URLs (e.g. TEST-KKW-W49-RK6Z → KKW-W49-RK6Z)
function dashboardAccountId(accountId: string): string {
  return accountId.replace(/^TEST-/i, "");
}

// Strip JSONP wrapper, e.g. globalJsonPCallback({...}), and return the inner JSON string
function stripJsonp(text: string): string {
  const m = text.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(([\s\S]*)\)\s*;?\s*$/);
  return m ? m[1] : text;
}

// Parse the exp claim from the at_c JWT in the cookie header
function parseAtcExpiry(cookieHeader: string): Date | undefined {
  const m = cookieHeader.match(/(?:^|[; ])at_c=([^;]+)/);
  if (!m) return undefined;
  try {
    const b64 = m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return payload.exp ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

// Returns true when the stored at_c token expires within the next 60 seconds
function isSessionExpired(session: WebSession): boolean {
  if (!session.atcExpiresAt) return false;
  return session.atcExpiresAt.getTime() < Date.now() + 60_000;
}

// Re-capture session silently using a headless browser and existing cookies.
// The browser will trigger Auth0 refresh automatically if rt_c is still valid.
// Returns the refreshed session, or null if rt_c is also expired (needs full re-login).
async function refreshSession(projectName: string, region: string): Promise<WebSession | null> {
  const existing = webSessions.get(projectName);
  if (!existing) return null;

  const baseUrl = dashboardUrl(region);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    // Restore existing cookies into the Playwright context
    const playwrightCookies = existing.cookie.split(/;\s*/).flatMap((pair) => {
      const idx = pair.indexOf("=");
      if (idx < 0) return [];
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1);
      return [{ name, value, domain: `${region}.dashboard.clevertap.com`, path: "/" as const }];
    });
    await context.addCookies(playwrightCookies);

    const page = await context.newPage();
    let capturedCsrf = "";
    page.on("response", async (response) => {
      const csrf = response.headers()["x-clevertap-csrf-token"];
      if (csrf) capturedCsrf = csrf;
    });

    await page.goto(`${baseUrl}/`, { waitUntil: "load", timeout: 60000 });

    // If we ended up on the login page, rt_c is also expired — needs full re-login
    if (page.url().includes("/login")) {
      await browser.close();
      return null;
    }

    await page.waitForTimeout(2000);
    const sessionData = await extractSession(context, region);
    await browser.close();

    if (!sessionData?.cookie) return null;

    const csrfToken = capturedCsrf || sessionData.csrfToken;
    const atcExpiresAt = parseAtcExpiry(sessionData.cookie);
    const refreshed: WebSession = { cookie: sessionData.cookie, csrfToken, region, capturedAt: new Date(), atcExpiresAt };
    webSessions.set(projectName, refreshed);
    return refreshed;
  } catch {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function extractSession(
  context: BrowserContext,
  region: string
): Promise<{ cookie: string; csrfToken: string } | null> {
  const origin = dashboardUrl(region);

  // Grab ALL cookies across all domains — at_c / rt_c are set on .clevertap.com
  // (not just the dashboard subdomain) so we need the full jar.
  const allCookies = await context.cookies();
  if (allCookies.length === 0) return null;

  // The Cookie header for requests to the dashboard needs:
  //  - cookies from the dashboard domain  (csrf, WSESSIONID, JSESSIONID, AWSALB*, etc.)
  //  - at_c / rt_c from .clevertap.com    (JWT access + refresh tokens)
  // We include everything that belongs to any clevertap.com subdomain.
  const dashboardHost = new URL(origin).hostname; // e.g. us1.dashboard.clevertap.com
  const cookies = allCookies.filter((c) =>
    dashboardHost.endsWith(c.domain.replace(/^\./, "")) ||
    c.domain.replace(/^\./, "") === "clevertap.com" ||
    dashboardHost.includes(c.domain.replace(/^\./, ""))
  );

  if (cookies.length === 0) return null;

  const cookieHeader = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  // Look for CSRF token in cookies — prefer exact 'csrf' name (integer token used in X-CleverTap-CSRF-Token)
  // before partial matches like 'secret_csrf' which is a UUID used by Auth0 only
  let csrfToken =
    cookies.find((c) => c.name === "csrf")?.value ??
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
      const accountId = projMeta.accountId;
      const baseUrl = dashboardUrl(region);
      // Navigate directly to the account dashboard so the session is scoped to this account.
      // dashboardAccountId strips the TEST- prefix used in REST API IDs but not in UI URLs.
      const entryUrl = `${baseUrl}/${dashboardAccountId(accountId)}/`;

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

        await page.goto(entryUrl, { waitUntil: "load", timeout: 60000 });

        // Wait until the user lands on ANY dashboard page (not login)
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

        // After login the user might be on a different account (e.g. PRD).
        // Navigate explicitly to this project's account URL so the session
        // (WSESSIONID, csrf cookie) gets scoped to the right account.
        const accountUrl = `${baseUrl}/${dashboardAccountId(accountId)}/`;
        if (!page.url().startsWith(accountUrl)) {
          await page.goto(accountUrl, { waitUntil: "load", timeout: 60000 });
          await page.waitForTimeout(2000);
        }

        // Reset captured CSRF now that we are on the right account page
        // (the response headers for this navigation will have the correct token)
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
        // Prefer the integer csrf cookie value; capturedCsrf from the response header is a UUID
        // used internally by Auth0 and is NOT the token the dashboard API expects.
        const csrfToken = sessionData.csrfToken || capturedCsrf;
        const atcExpiresAt = parseAtcExpiry(sessionData.cookie);

        webSessions.set(projectName, {
          cookie: sessionData.cookie,
          csrfToken,
          region,
          capturedAt: new Date(),
          atcExpiresAt,
        });

        await browser.close();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `✅ Web session captured for project "${projectName}"!`,
                "",
                `Dashboard  : ${accountUrl}`,
                `CSRF token : ${csrfToken ? csrfToken : "(not found — may not be needed)"}`,
                `Cookies    : ${sessionData.cookie.length} chars captured`,
                `Captured at: ${new Date().toISOString()}`,
                `Token exp  : ${atcExpiresAt ? atcExpiresAt.toISOString() : "(unknown)"}`,
                "",
                "You can now use clevertap_web_request to make dashboard API calls with these credentials.",
                "The session refreshes automatically before each request as long as your browser session is active.",
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

      const expired = isSessionExpired(session);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Web session for "${projectName}":`,
              `  Captured at : ${session.capturedAt.toISOString()}`,
              `  Token exp   : ${session.atcExpiresAt ? session.atcExpiresAt.toISOString() : "(unknown)"}`,
              `  Status      : ${expired ? "⚠️  expired (will auto-refresh on next request)" : "✅ active"}`,
              `  Region      : ${session.region}`,
              `  CSRF token  : ${session.csrfToken ? session.csrfToken : "(empty)"}`,
              `  Cookie size : ${session.cookie.length} chars`,
              `  Cookie names: ${session.cookie.split("; ").map((p) => p.split("=")[0]).join(", ")}`,
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
      let session = webSessions.get(projectName);

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

      if (isSessionExpired(session)) {
        const refreshed = await refreshSession(projectName, session.region);
        if (!refreshed) {
          return {
            content: [{ type: "text" as const, text: `Session for "${projectName}" has fully expired. Run clevertap_web_login to re-authenticate.` }],
            isError: true,
          };
        }
        session = refreshed;
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
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en,es;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "DNT": "1",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      };
      if (session.csrfToken) {
        headers["X-CleverTap-CSRF-Token"] = session.csrfToken;
      }

      let response = await fetch(url.toString(), {
        method,
        headers,
        redirect: "manual",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      // A redirect means the session expired server-side — try one silent refresh
      if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
        const refreshed = await refreshSession(projectName, session.region);
        if (!refreshed) {
          return { content: [{ type: "text" as const, text: `Session expired (server redirect). Run clevertap_web_login to re-authenticate.` }], isError: true };
        }
        session = refreshed;
        headers["Cookie"] = session.cookie;
        if (session.csrfToken) headers["X-CleverTap-CSRF-Token"] = session.csrfToken;
        response = await fetch(url.toString(), { method, headers, redirect: "manual", ...(body ? { body: JSON.stringify(body) } : {}) });
      }

      const responseText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripJsonp(responseText));
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
        .array(z.number().int())
        .optional()
        .describe(
          "Filter by campaign status codes: 0=scheduled, 1=running, 2=stopped, 3=completed, 7=approval pending, 9=rejected, 10=draft, 11=awaiting next run"
        ),
      channel: z
        .array(z.number().int())
        .optional()
        .describe("Filter by channel codes. Engagement: 2=push, 3=in-app message, 9=app inbox, 12=native display. Direct to user: 0=email, 1=SMS, 10=WhatsApp"),
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
        .default(100)
        .describe("Number of results per page (default 100, max 100)"),
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
        status?: number[];
        channel?: number[];
        campaign_type?: number[];
        page_size?: number;
        page_number?: number;
        purpose?: number;
        project?: string;
      };

      const projectName = projectArg ?? meta.defaultProject;
      let session = webSessions.get(projectName);

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

      if (isSessionExpired(session)) {
        const refreshed = await refreshSession(projectName, session.region);
        if (!refreshed) {
          return {
            content: [{ type: "text" as const, text: `Session for "${projectName}" has fully expired. Run clevertap_web_login to re-authenticate.` }],
            isError: true,
          };
        }
        session = refreshed;
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
        searchKeyword: search_keyword ?? null,
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

      const url = new URL(`${baseUrl}/${dashboardAccountId(accountId)}/json/report/load`);
      url.searchParams.set("q", JSON.stringify(q));
      url.searchParams.set("source", "");
      url.searchParams.set("limit", String(effectivePageSize));
      url.searchParams.set("uc", "1");
      url.searchParams.set("requestTs", String(Date.now()));

      const headers: Record<string, string> = {
        "Cookie": session.cookie,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en,es;q=0.9",
        "Referer": `${baseUrl}/${dashboardAccountId(accountId)}/campaigns`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "DNT": "1",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      };
      if (session.csrfToken) {
        headers["X-CleverTap-CSRF-Token"] = session.csrfToken;
      }

      let response = await fetch(url.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
      });

      // A redirect means the session expired server-side — try one silent refresh
      if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
        const refreshed = await refreshSession(projectName, session.region);
        if (!refreshed) {
          return { content: [{ type: "text" as const, text: `Session expired (server redirect). Run clevertap_web_login to re-authenticate.` }], isError: true };
        }
        session = refreshed;
        headers["Cookie"] = session.cookie;
        if (session.csrfToken) headers["X-CleverTap-CSRF-Token"] = session.csrfToken;
        response = await fetch(url.toString(), { method: "GET", headers, redirect: "manual" });
      }

      const responseText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripJsonp(responseText));
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
      "Send a test push notification to a specific device token via the CleverTap dashboard. " +
      "Requires a web session — call clevertap_web_login first. " +
      "Get the device token and channel from clevertap_get_profile (platformInfo[].push_token and profileData fields). " +
      "Use platform='ios' for APNS tokens (apnsTokens field), 'android' for FCM/GCM tokens (gcmIds field).",
    inputSchema: z.object({
      title: z.string().describe("Push notification title"),
      message: z.string().describe("Push notification body text"),
      device_token: z
        .string()
        .describe(
          "Device push token from the user's profile (platformInfo[].push_token). " +
          "Use the token matching the target platform (APNS for iOS, GCM/FCM for Android)."
        ),
      platform: z
        .enum(["ios", "android"])
        .describe("Target platform: 'ios' sends via apnsTokens, 'android' sends via gcmIds."),
      channel: z
        .string()
        .describe(
          "Push channel name configured in CleverTap (e.g. \"yummypush\"). " +
          "Used as wzrk_cid and channel in the payload."
        ),
      deep_link: z
        .string()
        .optional()
        .describe(
          "Optional deep link URL to attach to the notification (wzrk_dl). E.g. \"https://www.google.com/\" or a custom app scheme."
        ),
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
        title,
        message,
        device_token,
        platform,
        channel,
        deep_link,
        project: projectArg,
      } = args as {
        title: string;
        message: string;
        device_token: string;
        platform: "ios" | "android";
        channel: string;
        deep_link?: string;
        project?: string;
      };

      const projectName = projectArg ?? meta.defaultProject;
      let session = webSessions.get(projectName);

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

      if (isSessionExpired(session)) {
        const refreshed = await refreshSession(projectName, session.region);
        if (!refreshed) {
          return {
            content: [{ type: "text" as const, text: `Session for "${projectName}" has fully expired. Run clevertap_web_login to re-authenticate.` }],
            isError: true,
          };
        }
        session = refreshed;
      }

      const { accountId, region } = projMeta;
      const baseUrl = dashboardUrl(region);

      // Build token fields based on platform (matches real dashboard HAR request)
      const tokenFields = platform === "ios"
        ? { apnsTokens: device_token, isIOS: true, isAndroid: true }
        : { gcmIds: device_token, isAndroid: true, isIOS: true };

      const payload = {
        title,
        message,
        kv: {
          "1": {
            wzrk_cid: channel,
            wzrk_bc: "",
            wzrk_bi: "2",
            wzrk_sif: false,
            pr: "",
            wzrk_nms: "",
            del_pr: "high",
            ...(deep_link ? { wzrk_dl: deep_link } : {}),
          },
          "2": {
            wzrk_mutable_content: true,
            wzrk_interruption_level: "active",
            wzrk_relevance_score: 0.5,
            ...(deep_link ? { wzrk_dl: deep_link } : {}),
          },
          "3": {},
        },
        appId: 0,
        mode: "push",
        testPersonalisation: true,
        channel,
        type: "token",
        eventData: {
          eventPropertyMode: "0",
          event: -1,
          constantEventPropertyId: "",
          eventPropertyData: {},
        },
        contentApiNamespaces: [],
        contentApiLabelData: {},
        ...tokenFields,
      };

      const url = new URL(
        `${baseUrl}/${dashboardAccountId(accountId)}/json/push/interact/previewTarget`
      );
      url.searchParams.set("devices", ",android,ios");
      url.searchParams.set("uc", "1");
      url.searchParams.set("requestTs", String(Date.now()));

      const headers: Record<string, string> = {
        "Cookie": session.cookie,
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en,es;q=0.9",
        "Origin": baseUrl,
        "Referer": `${baseUrl}/${dashboardAccountId(accountId)}/campaigns/campaign/new/push/content`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "DNT": "1",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      };
      if (session.csrfToken) {
        headers["X-CleverTap-CSRF-Token"] = session.csrfToken;
      }

      let response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "manual",
      });

      // A redirect means the session expired server-side — try one silent refresh
      if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
        const refreshed = await refreshSession(projectName, session.region);
        if (!refreshed) {
          return { content: [{ type: "text" as const, text: `Session expired (server redirect). Run clevertap_web_login to re-authenticate.` }], isError: true };
        }
        session = refreshed;
        headers["Cookie"] = session.cookie;
        if (session.csrfToken) headers["X-CleverTap-CSRF-Token"] = session.csrfToken;
        response = await fetch(url.toString(), { method: "POST", headers, body: JSON.stringify(payload), redirect: "manual" });
      }

      const responseText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripJsonp(responseText));
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
