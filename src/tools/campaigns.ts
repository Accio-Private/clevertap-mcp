import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const campaignTools = [
  {
    name: "clevertap_get_campaigns",
    description:
      "List campaigns in CleverTap within a date range. Returns id, name, scheduled_on, and status for each campaign.",
    inputSchema: z.object({
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { from, to } = args as { from: string; to: string };
      return client.post("/targets/list.json", {
        from: parseInt(from),
        to: parseInt(to),
      });
    },
  },
  {
    name: "clevertap_get_campaign_report",
    description:
      "Get the delivery and engagement report for a specific campaign by its numeric ID.",
    inputSchema: z.object({
      id: z.number().int().describe("Campaign ID (integer)"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { id } = args as { id: number };
      return client.post("/targets/result.json", { id });
    },
  },
  {
    name: "clevertap_stop_campaign",
    description: "Stop an active running campaign by its numeric ID.",
    inputSchema: z.object({
      id: z.number().int().describe("Campaign ID (integer) to stop"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { id } = args as { id: number };
      return client.post("/targets/stop.json", { id });
    },
  },
  {
    name: "clevertap_create_campaign",
    description:
      "Create and launch a campaign targeting a segment of users. Supports push, email, SMS, web push, in-app, and webhook channels. For email/SMS/WhatsApp, provider_nick_name is required to select the configured provider.",
    inputSchema: z.object({
      name: z.string().describe("Campaign name"),
      target_mode: z
        .enum(["push", "email", "sms", "webpush", "in-app", "webhooks", "whatsapp", "notificationinbox"])
        .describe("Delivery channel for the campaign"),
      provider_nick_name: z
        .string()
        .optional()
        .describe(
          "Provider/vendor name to use for delivery. REQUIRED for email, SMS, and WhatsApp campaigns (e.g. 'SendGrid', 'Twilio'). Must match the provider nickname configured in your CleverTap account settings."
        ),
      when: z
        .union([
          z.string().describe(
            '"now" for immediate delivery, or "YYYYMMDD HH:MM" for a specific date/time'
          ),
          z.object({
            type: z.enum(["now", "later", "recurring"]).describe('Delivery type: "now", "later", or "recurring"'),
            delivery_date_time: z
              .array(z.string())
              .optional()
              .describe('Required when type="later". List of datetime strings in "YYYYMMDD HH:MM" format'),
            delivery_timezone: z
              .enum(["user", "account"])
              .optional()
              .describe("Deliver in user's local timezone or account timezone"),
            user_timezone_wrap_around: z
              .boolean()
              .optional()
              .describe("If true, deliver next day when user timezone has passed the scheduled time"),
            repeats_every: z
              .number()
              .int()
              .optional()
              .describe('Required when type="recurring". Number of days or weeks to repeat'),
            repeat_type: z
              .enum(["day", "week"])
              .optional()
              .describe('Required when type="recurring"'),
            start_time: z
              .string()
              .optional()
              .describe('Required when type="recurring". Format: "YYYYMMDD HH:MM"'),
            end_by_date: z
              .string()
              .optional()
              .describe('End date for recurring campaign. Format: "YYYYMMDD"'),
            end_by_occurrences: z
              .number()
              .int()
              .optional()
              .describe("End recurring campaign after this many occurrences"),
            repeat_on_days_of_week: z
              .array(z.number().int().min(1).max(7))
              .optional()
              .describe("Days of week [1=Sun, 7=Sat]. Required for recurring weekly campaigns"),
            campaign_cutoff: z
              .string()
              .optional()
              .describe('Stop sending after this time of day. Format: "HH:MM"'),
          }).describe("Scheduled delivery options object"),
        ])
        .describe(
          'When to send. Use "now" for immediate, "YYYYMMDD HH:MM" string for scheduled, or an object for recurring/timezone-aware scheduling'
        ),
      content: z
        .object({
          title: z
            .string()
            .optional()
            .describe("Notification title — required for push and webpush"),
          body: z
            .string()
            .optional()
            .describe(
              "Message body text. For email this is the full HTML body. For push/SMS this is the message text"
            ),
          subject: z
            .string()
            .optional()
            .describe("Email subject line — required for email campaigns"),
          sender_name: z
            .string()
            .optional()
            .describe("Sender display name — required for email campaigns (e.g. 'Acme Corp')"),
          sender_email: z
            .string()
            .optional()
            .describe("Sender email address override (if supported by provider)"),
          deepLink: z
            .string()
            .optional()
            .describe("Deep link URL (for push campaigns)"),
          imageUrl: z
            .string()
            .optional()
            .describe("Image URL (for push campaigns)"),
          platform_specific: z
            .record(z.unknown())
            .optional()
            .describe(
              "Platform-specific overrides keyed by platform (ios, android, chrome, safari, firefox, etc.)"
            ),
        })
        .describe(
          "Campaign content/message. Email requires: subject, body (HTML), sender_name. Push requires: title, body. SMS requires: body."
        ),
      where: z
        .object({
          event_name: z
            .string()
            .optional()
            .describe("Target users who performed this event"),
          from: z
            .string()
            .optional()
            .describe("Event from date in YYYYMMDD format"),
          to: z
            .string()
            .optional()
            .describe("Event to date in YYYYMMDD format"),
          profile_fields: z
            .array(
              z.object({
                name: z
                  .string()
                  .describe("Profile field name (e.g. 'Customer Type')"),
                operator: z
                  .string()
                  .describe(
                    "Operator: equals, greater_than, less_than, contains, not_equals, exists, does_not_exist, between"
                  ),
                value: z
                  .union([z.string(), z.number(), z.boolean()])
                  .optional()
                  .describe("Value to compare against (not needed for exists/does_not_exist)"),
              })
            )
            .optional()
            .describe("Additional profile property filters"),
        })
        .optional()
        .describe(
          "Segment targeting criteria (event + profile filters). Omit or send empty object to target all users"
        ),
      segment: z
        .number()
        .int()
        .optional()
        .describe(
          "Target users by a saved segment ID instead of specifying where criteria. Use this OR the where clause, not both."
        ),
      respect_frequency_caps: z
        .boolean()
        .optional()
        .describe("Whether to apply frequency caps (default true). Set false to override"),
      estimate_only: z
        .boolean()
        .optional()
        .describe("If true, returns estimated reach without actually creating the campaign"),
      subscription_groups: z
        .array(z.string())
        .optional()
        .describe(
          "Email only: send only to users subscribed to at least one of these subscription group names"
        ),
      send_email_to_opted_out_users: z
        .boolean()
        .optional()
        .describe(
          "Email only: when true, sends to all qualified users including those who have unsubscribed"
        ),
      draft: z
        .boolean()
        .optional()
        .describe("When true, saves as a draft instead of publishing immediately"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const {
        name,
        target_mode,
        provider_nick_name,
        when,
        content,
        where,
        segment,
        respect_frequency_caps,
        estimate_only,
        subscription_groups,
        send_email_to_opted_out_users,
        draft,
      } = args as {
        name: string;
        target_mode: string;
        provider_nick_name?: string;
        when: string | Record<string, unknown>;
        content: {
          title?: string;
          body?: string;
          subject?: string;
          sender_name?: string;
          sender_email?: string;
          deepLink?: string;
          imageUrl?: string;
          platform_specific?: Record<string, unknown>;
        };
        where?: {
          event_name?: string;
          from?: string;
          to?: string;
          profile_fields?: Array<{
            name: string;
            operator: string;
            value?: string | number | boolean;
          }>;
        };
        segment?: number;
        respect_frequency_caps?: boolean;
        estimate_only?: boolean;
        subscription_groups?: string[];
        send_email_to_opted_out_users?: boolean;
        draft?: boolean;
      };

      const payload: Record<string, unknown> = {
        name,
        target_mode,
        when,
        content,
      };

      if (provider_nick_name) payload.provider_nick_name = provider_nick_name;

      if (segment !== undefined) {
        payload.segment = segment;
      } else if (where) {
        const whereBody: Record<string, unknown> = {};
        if (where.event_name) whereBody.event_name = where.event_name;
        if (where.from) whereBody.from = parseInt(where.from);
        if (where.to) whereBody.to = parseInt(where.to);
        if (where.profile_fields && where.profile_fields.length > 0) {
          whereBody.common_profile_properties = {
            profile_fields: where.profile_fields,
          };
        }
        payload.where = whereBody;
      } else {
        // Target all users
        payload.where = {};
      }

      if (respect_frequency_caps !== undefined)
        payload.respect_frequency_caps = respect_frequency_caps;
      if (estimate_only !== undefined) payload.estimate_only = estimate_only;
      if (subscription_groups !== undefined)
        payload.subscription_groups = subscription_groups;
      if (send_email_to_opted_out_users !== undefined)
        payload.send_email_to_opted_out_users = send_email_to_opted_out_users;
      if (draft !== undefined) payload.draft = draft;

      return client.post("/targets/create.json", payload);
    },
  },
  {
    name: "clevertap_trigger_bulletin",
    description:
      "Trigger a Bulletin campaign based on a business event. Bulletins are pre-configured campaigns on the CleverTap dashboard that fire when a matching business event is raised via this API. All property values must be strings.",
    inputSchema: z.object({
      business_event: z
        .string()
        .describe("The business event name that triggers the bulletin (must be defined in the dashboard)"),
      name: z
        .string()
        .describe("Name/title for this bulletin instance (e.g. 'Episode 12 release')"),
      properties: z
        .record(z.string())
        .describe(
          "Key-value pairs describing the business event. All values must be strings. Keys limited to 120 chars, values to 512 bytes."
        ),
      creator: z
        .string()
        .describe("Admin email address of the bulletin creator (must be a valid admin email)"),
      when: z
        .union([z.string(), z.number()])
        .describe('Time of the event. Use "now" or a UNIX timestamp integer'),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { business_event, name, properties, creator, when } = args as {
        business_event: string;
        name: string;
        properties: Record<string, string>;
        creator: string;
        when: string | number;
      };
      return client.post("/targets/trigger.json", {
        business_event,
        name,
        properties,
        "c-by": creator,
        when,
      });
    },
  },
  {
    name: "clevertap_send_external_trigger",
    description:
      "Trigger delivery of a pre-built External Trigger campaign to one or more specific users via the CleverTap API. The campaign must be of type 'External Trigger' and already exist in the dashboard. Supports personalization via key-value pairs.",
    inputSchema: z.object({
      campaign_id: z
        .string()
        .describe("The numeric ID of the External Trigger campaign (as a string)"),
      to: z
        .object({
          email: z.array(z.string()).optional().describe("List of email addresses to target"),
          identity: z.array(z.string()).optional().describe("List of user identity values to target"),
          objectId: z.array(z.string()).optional().describe("List of CleverTap objectIds to target"),
        })
        .describe(
          "Target users — provide at least one of: email, identity, or objectId. For bulk sends (>1 user), provide multiple values in the array"
        ),
      kvPairs: z
        .record(z.string())
        .optional()
        .describe(
          "Key-value pairs for personalizing the campaign message (e.g. Name, product details). All values must be strings."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { campaign_id, to, kvPairs } = args as {
        campaign_id: string;
        to: { email?: string[]; identity?: string[]; objectId?: string[] };
        kvPairs?: Record<string, string>;
      };
      return client.post("/send/externaltrigger.json", {
        to,
        campaign_id,
        ExternalTrigger: kvPairs ?? {},
      });
    },
  },
];
