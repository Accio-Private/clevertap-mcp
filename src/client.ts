export type CleverTapRegion = "in1" | "us1" | "eu1" | "sg1" | "aps3" | "mec1";

export interface CleverTapConfig {
  accountId: string;
  passcode: string;
  region: CleverTapRegion;
}

export class CleverTapClient {
  private baseUrl: string;
  /** Root URL without /1 version prefix — used for custom-list, catalog, settings endpoints */
  readonly rootUrl: string;
  private headers: Record<string, string>;

  constructor(config: CleverTapConfig) {
    this.rootUrl = `https://${config.region}.api.clevertap.com`;
    this.baseUrl = `${this.rootUrl}/1`;
    this.headers = {
      "X-CleverTap-Account-Id": config.accountId,
      "X-CleverTap-Passcode": config.passcode,
      "Content-Type": "application/json",
    };
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CleverTap API error ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const headers = extraHeaders
      ? { ...this.headers, ...extraHeaders }
      : this.headers;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CleverTap API error ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * POST to a root-level endpoint (no /1 version prefix).
   * Used for Custom List, Catalog, and Settings APIs.
   */
  async postRoot<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.rootUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CleverTap API error ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * GET from a root-level endpoint (no /1 version prefix).
   * Used for Settings and Catalog multipart APIs.
   */
  async getRoot<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.rootUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CleverTap API error ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }

  async postWithPolling<T extends { status: string; req_id?: string }>(
    path: string,
    body: unknown,
    maxAttempts = 15,
    delayMs = 3000
  ): Promise<T> {
    let result = await this.post<T>(path, body);

    let attempts = 0;
    while (result.status === "partial" && result.req_id && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await this.get<T>(path, { req_id: result.req_id });
      attempts++;
    }

    return result;
  }

  async delete<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CleverTap API error ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }
}
