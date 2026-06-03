import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const catalogTools = [
  {
    name: "clevertap_get_catalog_presigned_url",
    description:
      "Step 1 of 3 for uploading a single-file product catalog. Requests a pre-signed S3 URL for uploading your catalog CSV (max 5GB per file). The URL is valid for up to 24 hours. For files larger than 5GB, use clevertap_get_catalog_multipart_presigned_urls instead.",
    inputSchema: z.object({}),
    handler: async (client: CleverTapClient, _args: unknown) => {
      return client.postRoot("/get_catalog_url");
    },
  },
  {
    name: "clevertap_upload_catalog_file",
    description:
      "Step 2 of 3 for uploading a catalog. Uploads your catalog CSV content to the pre-signed S3 URL from step 1. The CSV must have mandatory columns: Identity, Name, ImageURL, Category. Max 5GB, max 5 million rows, max 20 columns.",
    inputSchema: z.object({
      presigned_url: z
        .string()
        .describe("The pre-signed S3 URL returned by clevertap_get_catalog_presigned_url"),
      csv_content: z
        .string()
        .describe(
          "The catalog CSV content as a string. Must include header row with at minimum: Identity, Name, ImageURL, Category columns."
        ),
    }),
    handler: async (_client: CleverTapClient, args: unknown) => {
      const { presigned_url, csv_content } = args as {
        presigned_url: string;
        csv_content: string;
      };

      const response = await fetch(presigned_url, {
        method: "PUT",
        body: csv_content,
        headers: {
          "Content-Type": "text/csv",
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`S3 upload failed with status ${response.status}: ${error}`);
      }

      return {
        status: "success",
        message: "Catalog file uploaded successfully to S3. Proceed to step 3: clevertap_complete_catalog_upload",
        http_status: response.status,
      };
    },
  },
  {
    name: "clevertap_complete_catalog_upload",
    description:
      "Step 3 of 3 for uploading a single-file catalog. Notifies CleverTap that the upload is complete and triggers processing. CleverTap will email the result to the admin email provided. The catalog appears in the dashboard once processed.",
    inputSchema: z.object({
      name: z
        .string()
        .describe("Catalog name (e.g. 'Product_Catalog'). Must be unique unless replace=true"),
      creator: z
        .string()
        .describe("Name of the person uploading the catalog"),
      email: z
        .string()
        .describe("Admin email to receive processing result notifications. Must be a valid CleverTap admin email."),
      url: z
        .string()
        .describe("The same pre-signed S3 URL used in step 1 and step 2"),
      replace: z
        .boolean()
        .optional()
        .default(false)
        .describe("Set to true to replace an existing catalog with the same name. Default false."),
      override: z
        .boolean()
        .optional()
        .describe(
          "When replace=true, set this to true to force replacement even if columns are missing. Default false."
        ),
      isLocationCatalog: z
        .boolean()
        .optional()
        .describe("Set to true if this is a product location catalog. Default false (product catalog)."),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { name, creator, email, url, replace, override, isLocationCatalog } = args as {
        name: string;
        creator: string;
        email: string;
        url: string;
        replace?: boolean;
        override?: boolean;
        isLocationCatalog?: boolean;
      };
      const body: Record<string, unknown> = {
        name,
        creator,
        email,
        url,
        replace: replace ?? false,
      };
      if (override !== undefined) body.override = override;
      if (isLocationCatalog !== undefined) body.isLocationCatalog = isLocationCatalog;
      return client.postRoot("/upload_catalog_completed", body);
    },
  },
  {
    name: "clevertap_get_catalog_multipart_presigned_urls",
    description:
      "Request multiple pre-signed S3 URLs for uploading a large catalog file (>5GB) in parts. Split your catalog CSV into 2-4 parts (only the first part should have the header row; each part must end with a newline). Returns an array of presigned URLs plus an uploadId needed for completion.",
    inputSchema: z.object({
      total_parts: z
        .number()
        .int()
        .min(2)
        .max(4)
        .describe("Number of file parts to upload (minimum 2, maximum 4)"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { total_parts } = args as { total_parts: number };
      return client.getRoot("/get_multipart_upload_catalog_url", {
        totalParts: String(total_parts),
      });
    },
  },
];
