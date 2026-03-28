import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const genericTools = [
  {
    name: "clevertap_request",
    description: `Make any CleverTap API request with full control over path, method, body, and query params.
Use this for any endpoint or parameter combination not covered by the specific tools.

Examples:
- GET  /profile.json               { params: { identity: "user@email.com" } }
- POST /counts/trends.json         { body: { event_name: "App Installed", from: 20260327, to: 20260327, unique: true, groups: { daily: { trend_type: "daily" } } } }
- POST /upload                     { body: { d: [{ identity: "user@email.com", type: "profile", profileData: { Name: "John" } }] } }
- POST /counts/top.json            { body: { event_name: "App Installed", from: 20260327, to: 20260327, groups: { platform: { property_type: "event_properties", name: "platform" } } } }

When the response has status "partial" and a req_id, use clevertap_poll with that req_id and path to get the final result.`,
    inputSchema: z.object({
      path: z
        .string()
        .describe(
          'API path without base URL (e.g. "/counts/trends.json", "/profiles.json", "/upload")'
        ),
      method: z
        .enum(["GET", "POST", "DELETE"])
        .default("GET")
        .describe("HTTP method"),
      body: z
        .preprocess(
          (v) => (typeof v === "string" ? JSON.parse(v) : v),
          z.record(z.unknown())
        )
        .optional()
        .describe("Request body for POST/DELETE. Accepts any JSON structure."),
      params: z
        .record(z.string())
        .optional()
        .describe("Query string parameters for GET requests (key-value strings)."),
      poll: z
        .preprocess(
          (v) => (v === "true" ? true : v === "false" ? false : v),
          z.boolean()
        )
        .optional()
        .default(false)
        .describe(
          'If true and response is "partial", automatically polls until result is ready. Default false.'
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { path, method, body, params, poll } = args as {
        path: string;
        method: "GET" | "POST" | "DELETE";
        body?: Record<string, unknown>;
        params?: Record<string, string>;
        poll?: boolean;
      };

      const tryRequest = async (m: "GET" | "POST" | "DELETE") => {
        if (m === "GET") return client.get(path, params);
        if (m === "DELETE") return client.delete(path, body);
        if (poll) return client.postWithPolling(path, body ?? {});
        return client.post(path, body ?? {});
      };

      try {
        return await tryRequest(method);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // On 405 Method Not Allowed, retry with the opposite method
        if (msg.includes("405")) {
          const fallback =
            method === "GET" ? "POST" : method === "POST" ? "GET" : method;
          const result = await tryRequest(fallback as "GET" | "POST" | "DELETE");
          return {
            _note: `Original method ${method} returned 405. Retried with ${fallback} successfully.`,
            ...((result as object) ?? {}),
          };
        }
        throw err;
      }
    },
  },
  {
    name: "clevertap_poll",
    description: `Poll a CleverTap async result using a req_id returned from a previous "partial" response.
Use this after clevertap_request returns { "status": "partial", "req_id": "..." }.

Keeps polling via GET /{path}?req_id={req_id} until status is "success" or "fail".`,
    inputSchema: z.object({
      path: z
        .string()
        .describe('Same path used in the original request (e.g. "/counts/trends.json")'),
      req_id: z
        .string()
        .describe('The req_id value from the partial response'),
      max_attempts: z
        .number()
        .min(1)
        .max(30)
        .optional()
        .default(15)
        .describe("Max polling attempts (default 15, ~45 seconds total)"),
      delay_ms: z
        .number()
        .min(500)
        .max(10000)
        .optional()
        .default(3000)
        .describe("Milliseconds between polling attempts (default 3000)"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { path, req_id, max_attempts = 15, delay_ms = 3000 } = args as {
        path: string;
        req_id: string;
        max_attempts?: number;
        delay_ms?: number;
      };

      let attempts = 0;
      let result: Record<string, unknown> = { status: "partial", req_id };

      while (result["status"] === "partial" && attempts < max_attempts) {
        await new Promise((resolve) => setTimeout(resolve, delay_ms));
        result = await client.get<Record<string, unknown>>(path, { req_id });
        attempts++;
      }

      return result;
    },
  },
];
