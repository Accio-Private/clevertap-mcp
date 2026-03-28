import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const reportTools = [
  {
    name: "clevertap_get_message_report",
    description:
      "Get delivery and engagement report for campaigns (sent, delivered, opened, clicked rates). Filter by channel, delivery type, label, status, and more.",
    inputSchema: z.object({
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
      channel: z
        .array(z.string())
        .optional()
        .describe(
          "Filter by channels: push, email, sms, browser, inapp, webhooks, whatsapp"
        ),
      delivery: z
        .array(z.string())
        .optional()
        .describe(
          "Filter by delivery type: one_time, inaction, action, recurring, property_time, api"
        ),
      daily: z
        .boolean()
        .optional()
        .describe("If true, return daily breakdown"),
      status: z
        .array(z.string())
        .optional()
        .describe("Filter by campaign status"),
      message_type: z
        .array(z.string())
        .optional()
        .describe("Filter by message type"),
      label: z
        .array(z.string())
        .optional()
        .describe("Filter by campaign labels"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { from, to, channel, delivery, daily, status, message_type, label } =
        args as {
          from: string;
          to: string;
          channel?: string[];
          delivery?: string[];
          daily?: boolean;
          status?: string[];
          message_type?: string[];
          label?: string[];
        };
      const body: Record<string, unknown> = { from, to };
      if (channel) body.channel = channel;
      if (delivery) body.delivery = delivery;
      if (daily !== undefined) body.daily = daily;
      if (status) body.status = status;
      if (message_type) body.message_type = message_type;
      if (label) body.label = label;
      return client.post("/message/report.json", body);
    },
  },
  {
    name: "clevertap_get_top_property_count",
    description:
      "Get the count of the top property values for a given event (e.g. top 10 product categories viewed). Supports polling for async results.",
    inputSchema: z.object({
      event_name: z.string().describe("Event name to analyze"),
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
      groups: z
        .record(
          z.object({
            property_type: z
              .string()
              .describe(
                "Property category: event_properties, session_properties, profile_fields, app_fields, demographics, technographics, reachability, geo_fields"
              ),
            name: z.string().describe("Property name to group by"),
            top_n: z
              .number()
              .optional()
              .describe("Number of top values to return (default 10)"),
            order: z
              .enum(["asc", "desc"])
              .optional()
              .describe("Sort order (default desc)"),
          })
        )
        .describe(
          "Groups definition. Key is a label for this group, value defines the property to analyze."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to, groups } = args as {
        event_name: string;
        from: string;
        to: string;
        groups: Record<
          string,
          { property_type: string; name: string; top_n?: number; order?: string }
        >;
      };
      return client.postWithPolling("/counts/top.json", {
        event_name,
        from: parseInt(from),
        to: parseInt(to),
        groups,
      });
    },
  },
  {
    name: "clevertap_get_event_trend",
    description:
      "Get a trend of event occurrences over time (daily, weekly, or monthly). Supports polling for async results.",
    inputSchema: z.object({
      event_name: z.string().describe("Event name to get trend for"),
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
      groups: z
        .record(
          z.object({
            trend_type: z
              .enum(["daily", "weekly", "monthly"])
              .describe("Trend granularity"),
          })
        )
        .describe(
          'Trend groups. Key is a label (e.g. "daily"), value must include trend_type.'
        ),
      unique: z
        .boolean()
        .optional()
        .describe("If true, count unique users instead of total events"),
      sum_event_prop: z
        .string()
        .optional()
        .describe(
          "Sum values of this numeric event property across the trend period"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to, groups, unique, sum_event_prop } = args as {
        event_name: string;
        from: string;
        to: string;
        groups: Record<string, { trend_type: string }>;
        unique?: boolean;
        sum_event_prop?: string;
      };

      const body: Record<string, unknown> = {
        event_name,
        from: parseInt(from),
        to: parseInt(to),
        groups,
      };
      if (unique !== undefined) body.unique = unique;
      if (sum_event_prop) body.sum_event_prop = sum_event_prop;

      return client.postWithPolling("/counts/trends.json", body);
    },
  },
  {
    name: "clevertap_get_dau",
    description:
      "Get Daily Active Users (DAU) count for a given date range (unique App Launched events).",
    inputSchema: z.object({
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { from, to } = args as { from: string; to: string };
      return client.postWithPolling("/counts/trends.json", {
        event_name: "App Launched",
        from: parseInt(from),
        to: parseInt(to),
        unique: true,
        groups: { daily: { trend_type: "daily" } },
      });
    },
  },
  {
    name: "clevertap_get_uninstall_report",
    description: "Get the uninstall count trend over a date range.",
    inputSchema: z.object({
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { from, to } = args as { from: string; to: string };
      return client.postWithPolling("/counts/trends.json", {
        event_name: "Uninstalled",
        from: parseInt(from),
        to: parseInt(to),
        unique: true,
        groups: { daily: { trend_type: "daily" } },
      });
    },
  },
  {
    name: "clevertap_get_real_time_counts",
    description:
      "Get the count of users who are actively using the app right now (within the last 5 minutes). Optionally includes a breakdown by user type.",
    inputSchema: z.object({
      user_type: z
        .boolean()
        .optional()
        .describe(
          "If true, includes a breakdown by user type in the response"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { user_type } = args as { user_type?: boolean };
      return client.post("/now.json", user_type ? { user_type } : {});
    },
  },
];

