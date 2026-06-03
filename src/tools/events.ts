import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const eventTools = [
  {
    name: "clevertap_upload_events",
    description:
      "Upload one or more events for users to CleverTap. Use this to track actions like purchases, logins, page views, etc. Max 1000 records per call.",
    inputSchema: z.object({
      events: z
        .array(
          z.object({
            identity: z
              .string()
              .describe("Unique user identity (email, phone, or custom ID)"),
            evtName: z
              .string()
              .describe("Name of the event (e.g. 'Product Viewed')"),
            evtData: z
              .record(z.unknown())
              .optional()
              .describe("Key-value properties for the event"),
            ts: z
              .number()
              .optional()
              .describe(
                "Unix timestamp of the event. Defaults to now if omitted."
              ),
          })
        )
        .min(1)
        .describe("List of events to upload"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { events } = args as {
        events: Array<{
          identity: string;
          evtName: string;
          evtData?: Record<string, unknown>;
          ts?: number;
        }>;
      };

      const d = events.map((e) => ({
        identity: e.identity,
        type: "event",
        evtName: e.evtName,
        ...(e.evtData ? { evtData: e.evtData } : {}),
        ...(e.ts ? { ts: e.ts } : {}),
      }));

      return client.post("/upload", { d });
    },
  },
  {
    name: "clevertap_get_events",
    description:
      "Query event data for a specific event within a date range. Returns a cursor token for paginated results — use clevertap_get_events_cursor to fetch subsequent pages.",
    inputSchema: z.object({
      event_name: z.string().describe("Name of the event to query"),
      from: z.string().describe("Start date in YYYYMMDD format (e.g. '20240101')"),
      to: z.string().describe("End date in YYYYMMDD format (e.g. '20240131')"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to } = args as {
        event_name: string;
        from: string;
        to: string;
      };

      const body: Record<string, unknown> = {
        event_name,
        from: parseInt(from),
        to: parseInt(to),
      };

      return client.post("/events.json", body);
    },
  },
  {
    name: "clevertap_get_events_cursor",
    description:
      "Fetch the next page of event results using a cursor returned from clevertap_get_events.",
    inputSchema: z.object({
      cursor: z
        .string()
        .describe("Cursor string returned from a previous events query"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { cursor } = args as { cursor: string };
      return client.get("/events.json", { cursor });
    },
  },
  {
    name: "clevertap_get_event_count",
    description:
      "Get the total count of users who performed a specific event within a date range. Supports optional event property filters. Uses automatic async polling when the result is not immediately ready.",
    inputSchema: z.object({
      event_name: z.string().describe("Name of the event to count"),
      from: z
        .string()
        .describe("Start date in YYYYMMDD format (e.g. '20240101')"),
      to: z
        .string()
        .describe("End date in YYYYMMDD format (e.g. '20240131')"),
      event_properties: z
        .array(
          z.object({
            name: z.string().describe("Property name"),
            operator: z
              .string()
              .describe(
                "Comparison operator (equals, contains, notEquals, greaterThan, lessThan, etc.)"
              ),
            value: z
              .union([z.string(), z.number(), z.boolean()])
              .describe("Value to compare against"),
          })
        )
        .optional()
        .describe("Optional filters on event properties"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to, event_properties } = args as {
        event_name: string;
        from: string;
        to: string;
        event_properties?: Array<{
          name: string;
          operator: string;
          value: string | number | boolean;
        }>;
      };
      const body: Record<string, unknown> = {
        event_name,
        from: parseInt(from),
        to: parseInt(to),
      };
      if (event_properties) body.event_properties = event_properties;
      return client.postWithPolling("/counts/events.json", body);
    },
  },
];
