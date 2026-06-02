import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

// TTLs (seconds)
const TTL_SESSION = 10 * 60; // 10 min
const TTL_AUTH_CODE = 10 * 60; // 10 min
const TTL_CLIENT = 90 * 24 * 60 * 60; // 90 days
const TTL_USER_PROFILE = 90 * 24 * 60 * 60; // 90 days

const key = {
  client: (id: string) => `mcp:oauth:client:${id}`,
  clientByName: (name: string) => `mcp:oauth:client_name:${name}`,
  authCode: (code: string) => `mcp:oauth:code:${code}`,
  session: (id: string) => `mcp:oauth:session:${id}`,
  userProfile: (id: string) => `mcp:oauth:profile:${id}`,
  providerIndex: (provider: string, providerUserId: string) =>
    `mcp:oauth:profile_idx:${provider}:${providerUserId}`,
};

export type StoredAuthCode = {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  user_id: string;
  scope?: string;
  resource?: string;
  expires_at: number;
  user_profile_id?: string;
};

export type StoredOAuthSession = {
  sessionId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  oauthState?: string;
  scope?: string;
  resource?: string;
  expiresAt: number;
};

export type OAuthUserProfile = {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
};

export class RedisOAuthStore {
  private readonly redis: Redis;

  constructor(host: string, port: number) {
    this.redis = new Redis({ lazyConnect: true, host, port });
    this.redis.on("error", (err: Error) => {
      console.error("[RedisOAuthStore] Redis error:", err);
    });
  }

  async destroy(): Promise<void> {
    await this.redis.quit();
  }

  // ── Clients ──────────────────────────────────────────────────────────────────

  generateClientId(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): string {
    const obj = client as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      normalized[k] = Array.isArray(v) ? [...v].sort() : v;
    }
    const hash = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");
    const safeName = (
      (client.client_name as string) || "client"
    )
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    return `${safeName}_${hash.substring(0, 16)}`;
  }

  async storeClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const serialized = JSON.stringify(client);
    const name = (client.client_name as string) || client.client_id;
    await Promise.all([
      this.redis.set(key.client(client.client_id), serialized, "EX", TTL_CLIENT),
      this.redis.set(key.clientByName(name), client.client_id, "EX", TTL_CLIENT),
    ]);
    return client;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const raw = await this.redis.get(key.client(clientId));
    return raw ? (JSON.parse(raw) as OAuthClientInformationFull) : undefined;
  }

  // ── Authorization codes ───────────────────────────────────────────────────────

  async storeAuthCode(code: StoredAuthCode): Promise<void> {
    const ttl = Math.max(
      1,
      Math.ceil((code.expires_at - Date.now()) / 1000),
    );
    await this.redis.set(
      key.authCode(code.code),
      JSON.stringify(code),
      "EX",
      ttl || TTL_AUTH_CODE,
    );
  }

  async getAuthCode(code: string): Promise<StoredAuthCode | undefined> {
    const raw = await this.redis.get(key.authCode(code));
    return raw ? (JSON.parse(raw) as StoredAuthCode) : undefined;
  }

  async removeAuthCode(code: string): Promise<void> {
    await this.redis.del(key.authCode(code));
  }

  // ── OAuth sessions ────────────────────────────────────────────────────────────

  async storeSession(session: StoredOAuthSession): Promise<void> {
    const ttl = Math.max(
      1,
      Math.ceil((session.expiresAt - Date.now()) / 1000),
    );
    await this.redis.set(
      key.session(session.sessionId),
      JSON.stringify(session),
      "EX",
      ttl || TTL_SESSION,
    );
  }

  async getSession(sessionId: string): Promise<StoredOAuthSession | undefined> {
    const raw = await this.redis.get(key.session(sessionId));
    if (!raw) return undefined;
    const session = JSON.parse(raw) as StoredOAuthSession;
    if (session.expiresAt < Date.now()) {
      await this.redis.del(key.session(sessionId));
      return undefined;
    }
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.redis.del(key.session(sessionId));
  }

  // ── User profiles ─────────────────────────────────────────────────────────────

  async upsertUserProfile(
    profile: OAuthUserProfile,
    provider: string,
  ): Promise<string> {
    const idxKey = key.providerIndex(provider, profile.id);
    let profileId = await this.redis.get(idxKey);

    if (!profileId) {
      profileId = createHash("sha256")
        .update(`${provider}:${profile.id}`)
        .digest("hex")
        .slice(0, 24);
      await this.redis.set(idxKey, profileId, "EX", TTL_USER_PROFILE);
    }

    const stored = { profile_id: profileId, provider, ...profile };
    await this.redis.set(
      key.userProfile(profileId),
      JSON.stringify(stored),
      "EX",
      TTL_USER_PROFILE,
    );
    return profileId;
  }

  async getUserProfileById(
    profileId: string,
  ): Promise<(OAuthUserProfile & { profile_id: string; provider: string }) | undefined> {
    const raw = await this.redis.get(key.userProfile(profileId));
    return raw
      ? (JSON.parse(raw) as OAuthUserProfile & {
          profile_id: string;
          provider: string;
        })
      : undefined;
  }

  async ping(): Promise<string> {
    return this.redis.ping();
  }
}
