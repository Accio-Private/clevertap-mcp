import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const profileTools = [
  {
    name: "clevertap_upload_profile",
    description:
      "Create or update a user profile in CleverTap. Use this to set user attributes like name, email, phone, age, gender, or custom properties. Max 1000 profiles per request.",
    inputSchema: z.object({
      identity: z
        .string()
        .describe("Unique user identity (email, phone, or custom ID)"),
      profileData: z
        .object({
          Name: z.string().optional().describe("Full name of the user"),
          Email: z.string().optional().describe("Email address"),
          Phone: z
            .string()
            .optional()
            .describe("Phone number with country code (e.g. +14155551234)"),
          Gender: z.enum(["M", "F"]).optional().describe("Gender: M or F"),
          DOB: z
            .string()
            .optional()
            .describe("Date of birth in YYYY-MM-DD format"),
          Age: z.number().optional().describe("Age of the user"),
          MSG_email: z
            .boolean()
            .optional()
            .describe("Opt-in/out for email messaging"),
          MSG_push: z
            .boolean()
            .optional()
            .describe("Opt-in/out for push notifications"),
          MSG_sms: z.boolean().optional().describe("Opt-in/out for SMS"),
          MSG_whatsapp: z
            .boolean()
            .optional()
            .describe("Opt-in/out for WhatsApp"),
        })
        .and(z.record(z.unknown()))
        .describe(
          "Profile properties to set. Standard fields + any custom properties."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { identity, profileData } = args as {
        identity: string;
        profileData: Record<string, unknown>;
      };

      return client.post("/upload", {
        d: [{ identity, type: "profile", profileData }],
      });
    },
  },
  {
    name: "clevertap_get_profile",
    description:
      "Retrieve a user profile from CleverTap. Provide at least one of: identity, email, or objectId (GUID).",
    inputSchema: z.object({
      identity: z
        .string()
        .optional()
        .describe("Custom user identity (email, phone, or custom ID)"),
      email: z.string().optional().describe("User email address"),
      objectId: z
        .string()
        .optional()
        .describe("CleverTap GUID (objectId)"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { identity, email, objectId } = args as {
        identity?: string;
        email?: string;
        objectId?: string;
      };
      if (!identity && !email && !objectId) {
        throw new Error("At least one of identity, email, or objectId must be provided");
      }
      const params: Record<string, string> = {};
      if (identity) params.identity = identity;
      if (email) params.email = email;
      if (objectId) params.objectId = objectId;
      return client.get("/profile.json", params);
    },
  },
  {
    name: "clevertap_get_profiles_by_event",
    description:
      "Get a list of user profiles who performed a specific event within a date range. Returns a cursor for paginated results — use clevertap_get_profiles_cursor to fetch subsequent pages.",
    inputSchema: z.object({
      event_name: z.string().describe("Event name to filter profiles by"),
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to } = args as {
        event_name: string;
        from: string;
        to: string;
      };
      return client.post("/profiles.json?batch_size=50", {
        event_name,
        from: parseInt(from),
        to: parseInt(to),
      });
    },
  },
  {
    name: "clevertap_get_profiles_cursor",
    description:
      "Fetch the next page of user profiles using a cursor returned from clevertap_get_profiles_by_event.",
    inputSchema: z.object({
      cursor: z
        .string()
        .describe("Cursor string returned from a previous profiles query"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { cursor } = args as { cursor: string };
      return client.get("/profiles.json", { cursor });
    },
  },
  {
    name: "clevertap_delete_profile",
    description:
      "Delete one or more user profiles from CleverTap. Processing occurs during non-business hours. Max 100 IDs per request.",
    inputSchema: z.object({
      identity: z
        .union([z.string(), z.array(z.string())])
        .describe(
          "Identity or array of identities to delete (email, phone, or custom ID)"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { identity } = args as { identity: string | string[] };
      return client.post("/delete/profiles.json", { identity });
    },
  },
  {
    name: "clevertap_upload_device_token",
    description:
      "Upload a push notification device token and associate it with a user profile. Identified by objectId (GUID) only — not by identity or email. For Chrome web push tokens, also provide chrome_keys.",
    inputSchema: z.object({
      objectId: z
        .string()
        .describe(
          "CleverTap GUID (objectId) of the user — must be a GUID, not an identity/email"
        ),
      token_id: z.string().describe("The device token string"),
      token_type: z
        .enum(["apns", "gcm", "fcm", "wns", "mpns", "chrome"])
        .describe("Token type / push platform"),
      chrome_keys: z
        .object({
          p256dh: z.string().describe("Chrome P-256 Diffie-Hellman public key"),
          auth: z.string().describe("Chrome auth secret"),
        })
        .optional()
        .describe("Required only for chrome token_type"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { objectId, token_id, token_type, chrome_keys } = args as {
        objectId: string;
        token_id: string;
        token_type: string;
        chrome_keys?: { p256dh: string; auth: string };
      };
      const tokenData: Record<string, unknown> = { id: token_id, type: token_type };
      if (chrome_keys) tokenData.keys = chrome_keys;
      return client.post("/upload", {
        d: [{ type: "token", tokenData, objectId }],
      });
    },
  },
  {
    name: "clevertap_get_profile_count",
    description:
      "Get the count of user profiles who performed a specific event within a date range. Supports optional event property filters. Uses automatic async polling when the result is not immediately ready.",
    inputSchema: z.object({
      event_name: z.string().describe("Event name to filter profiles by"),
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
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
      return client.postWithPolling("/counts/profiles.json", body);
    },
  },
  {
    name: "clevertap_demerge_profile",
    description:
      "Demerge (unmerge) user profiles that were incorrectly merged in CleverTap. Max 100 identities per request.",
    inputSchema: z.object({
      identities: z
        .union([z.string(), z.array(z.string())])
        .describe("Identity or array of identities of profiles to demerge (max 100)"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { identities } = args as { identities: string | string[] };
      const identityArray = Array.isArray(identities) ? identities : [identities];
      return client.post("/demerge/profiles.json", { identities: identityArray });
    },
  },
  {
    name: "clevertap_subscribe",
    description:
      "Subscribe or unsubscribe users from a specific channel (phone, email, or WhatsApp). Max 1000 records per request.",
    inputSchema: z.object({
      subscriptions: z
        .array(
          z.object({
            type: z
              .enum(["phone", "email", "whatsapp"])
              .describe("Channel type"),
            value: z
              .string()
              .describe("Phone number (with country code) or email address"),
            status: z
              .enum(["Unsubscribe", "Resubscribe"])
              .describe("Subscription action"),
          })
        )
        .min(1)
        .describe("List of subscription changes"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { subscriptions } = args as {
        subscriptions: Array<{ type: string; value: string; status: string }>;
      };
      return client.post("/subscribe", { d: subscriptions });
    },
  },
  {
    name: "clevertap_disassociate_phone",
    description:
      "Disassociate a phone number from its user profile in CleverTap. Only works when the phone number is used as the user's primary identity. Max 1000 records per request.",
    inputSchema: z.object({
      phones: z
        .union([z.string(), z.array(z.string())])
        .describe(
          "Phone number(s) with country code to disassociate (e.g. '+14155551234')"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { phones } = args as { phones: string | string[] };
      const phoneArray = Array.isArray(phones) ? phones : [phones];
      const d = phoneArray.map((value) => ({ type: "phone", value }));
      return client.post("/disassociate", { d });
    },
  },
];

