import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const customListTools = [
  {
    name: "clevertap_get_custom_list_presigned_url",
    description:
      "Step 1 of 3 for uploading a custom list segment. Requests a pre-signed S3 URL from CleverTap that you can use to upload your CSV file. The URL is valid for up to 24 hours.",
    inputSchema: z.object({}),
    handler: async (client: CleverTapClient, _args: unknown) => {
      return client.postRoot("/get_custom_list_segment_url");
    },
  },
  {
    name: "clevertap_upload_custom_list_file",
    description:
      "Step 2 of 3 for uploading a custom list segment. Uploads your CSV content directly to the pre-signed S3 URL obtained in step 1. The CSV MUST have exactly two columns: 'Type' and 'Identity'. This performs a PUT request to the S3 URL — no CleverTap auth needed for this step.",
    inputSchema: z.object({
      presigned_url: z
        .string()
        .describe(
          "The pre-signed S3 URL returned by clevertap_get_custom_list_presigned_url",
        ),
      csv_content: z
        .string()
        .describe(
          "The CSV content as a string. REQUIRED format: two columns with header row 'Type,Identity'.\n" +
            "  - 'Type' column: 'i' for identity (phone number, email, or custom ID) OR 'g' for CleverTap GUID/objectId\n" +
            "  - 'Identity' column: the actual identifier value\n" +
            "Example (phone/email/custom ID): 'Type,Identity\\ni,+919877308060\\ni,[email protected]'\n" +
            "Example (CleverTap GUIDs):        'Type,Identity\\ng,m-TBnMjKIz1I04WnCkqLpMMDssAckVIN'\n" +
            "Using a single-column or wrong header will cause silent failure (API returns success but email reports an error).",
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
        throw new Error(
          `S3 upload failed with status ${response.status}: ${error}`,
        );
      }

      return {
        status: "success",
        message:
          "File uploaded successfully to S3. Proceed to step 3: clevertap_complete_custom_list_upload",
        http_status: response.status,
      };
    },
  },
  {
    name: "clevertap_complete_custom_list_upload",
    description:
      "Step 3 of 3 for uploading a custom list segment. Notifies CleverTap that the file upload is complete and triggers processing to create the segment. CleverTap will email the segment creation result to the provided admin email. Returns a segment ID on success.",
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          "Name for the custom list segment (will appear in the CleverTap dashboard)",
        ),
      creator: z.string().describe("Name of the person creating this segment"),
      filename: z
        .string()
        .describe("The filename of the CSV you uploaded (e.g. 'my_list.csv')"),
      email: z
        .string()
        .describe(
          "Admin email address to receive the processing result notification. Must be a valid CleverTap admin email.",
        ),
      url: z
        .string()
        .describe("The same pre-signed S3 URL used in step 1 and step 2"),
      replace: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Set to true to replace an existing segment with the same name. Default false (creates new segment). " +
            "IMPORTANT: if a segment with the same name already exists — even from a previous failed attempt — you MUST set replace=true or this call will fail with a 'duplicate_name' error.",
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { name, creator, filename, email, url, replace } = args as {
        name: string;
        creator: string;
        filename: string;
        email: string;
        url: string;
        replace?: boolean;
      };
      return client.postRoot("/upload_custom_list_segment_completed", {
        name,
        creator,
        filename,
        email,
        url,
        replace: replace ?? false,
      });
    },
  },
];
