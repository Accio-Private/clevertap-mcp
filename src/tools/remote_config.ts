import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const remoteConfigTools = [
  {
    name: "clevertap_create_variables",
    description:
      "Create or define Remote Config variables in CleverTap. Variables allow you to remotely control app behaviour without a new app release. Newly created variables must be Published from the CleverTap dashboard before they take effect in the app.",
    inputSchema: z.object({
      variables: z
        .array(
          z.object({
            name: z
              .string()
              .describe(
                'Variable name. Use dot notation for folders (e.g. "folder1.varName"). Names are limited to 120 characters.'
              ),
            type: z
              .enum(["string", "boolean", "number"])
              .describe("Variable data type"),
            defaultValue: z
              .union([z.string(), z.boolean(), z.number()])
              .describe("Default value for the variable. Must match the declared type."),
            description: z
              .string()
              .optional()
              .describe("Optional description of what this variable controls"),
          })
        )
        .min(1)
        .describe("List of variables to create/define"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { variables } = args as {
        variables: Array<{
          name: string;
          type: string;
          defaultValue: string | boolean | number;
          description?: string;
        }>;
      };

      const variableDefinitions: Record<string, unknown> = {};
      for (const v of variables) {
        const def: Record<string, unknown> = {
          type: v.type,
          defaultValue: v.defaultValue,
        };
        if (v.description) def.description = v.description;
        variableDefinitions[v.name] = def;
      }

      return client.post("/createVars", { variableDefinitions });
    },
  },
  {
    name: "clevertap_get_variables",
    description:
      "Retrieve all Remote Config variables defined for this CleverTap project, along with their types, default values, and descriptions.",
    inputSchema: z.object({}),
    handler: async (client: CleverTapClient, _args: unknown) => {
      return client.get("/getVars");
    },
  },
  {
    name: "clevertap_delete_variables",
    description:
      "Delete one or more Remote Config variables from CleverTap. This permanently removes the variable definition. Any app referencing the deleted variable will fall back to the in-app default.",
    inputSchema: z.object({
      variable_names: z
        .array(z.string())
        .min(1)
        .describe("List of variable names to delete (e.g. ['folder1.var1', 'myVar'])"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { variable_names } = args as { variable_names: string[] };
      return client.delete("/deleteVars", { variableNames: variable_names });
    },
  },
  {
    name: "clevertap_get_subscription_groups",
    description:
      "Retrieve all email subscription groups configured in your CleverTap account settings. Use group names in create_campaign's subscription_groups field to restrict email sends to subscribed users only.",
    inputSchema: z.object({}),
    handler: async (client: CleverTapClient, _args: unknown) => {
      return client.getRoot("/category-groups");
    },
  },
];
