import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RedisOAuthStore } from "./redis-store.js";
import type { JwtService } from "./jwt-service.js";

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 min
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 min
export const OAUTH_SESSION_COOKIE = "mcp_oauth_session";

export class GoogleOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = false;

  private readonly _clientsStore: OAuthRegisteredClientsStore;
  private readonly isProduction: boolean;

  constructor(
    private readonly store: RedisOAuthStore,
    private readonly jwtService: JwtService,
    private readonly googleClientId: string,
    private readonly googleClientSecret: string,
    private readonly serverUrl: string,
    private readonly resourceUrl: string,
  ) {
    this.isProduction =
      !serverUrl.includes("localhost") &&
      !serverUrl.includes("127.0.0.1");

    this._clientsStore = {
      getClient: async (clientId: string) =>
        store.getClient(clientId),
      registerClient: async (
        client: Omit<
          OAuthClientInformationFull,
          "client_id" | "client_id_issued_at"
        >,
      ) => {
        const clientId = store.generateClientId(client);
        const registered: OAuthClientInformationFull = {
          ...client,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        await store.storeClient(registered);
        return registered;
      },
    };
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  // ── Called by mcpAuthRouter's /authorize handler ──────────────────────────────

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const sessionId = randomBytes(32).toString("base64url");

    await this.store.storeSession({
      sessionId,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      oauthState: params.state,
      scope: params.scopes?.join(" "),
      resource: this.resourceUrl,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    res.cookie(OAUTH_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: "lax",
      maxAge: SESSION_TTL_MS,
    });

    const googleUrl = new URL(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    googleUrl.searchParams.set("client_id", this.googleClientId);
    googleUrl.searchParams.set(
      "redirect_uri",
      `${this.serverUrl}/auth/callback`,
    );
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", "openid email profile");
    googleUrl.searchParams.set("state", sessionId);
    googleUrl.searchParams.set("access_type", "offline");

    res.redirect(googleUrl.toString());
  }

  // ── Called by mcpAuthRouter's /token handler before exchangeAuthorizationCode ─

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const code = await this.store.getAuthCode(authorizationCode);
    if (!code) throw new Error("Invalid or unknown authorization code");
    return code.code_challenge;
  }

  // ── Called by mcpAuthRouter's /token handler (PKCE already verified) ──────────

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = await this.store.getAuthCode(authorizationCode);
    if (!code) throw new Error("Invalid authorization code");
    if (code.expires_at < Date.now()) {
      await this.store.removeAuthCode(authorizationCode);
      throw new Error("Authorization code has expired");
    }
    if (code.client_id !== client.client_id) {
      throw new Error("Client ID mismatch");
    }

    const resourceUrl = resource?.href ?? code.resource ?? this.resourceUrl;
    const tokens = this.jwtService.generateTokenPair(
      code.user_id,
      client.client_id,
      resourceUrl,
      code.scope ?? "",
      code.user_profile_id,
    );
    await this.store.removeAuthCode(authorizationCode);
    return tokens;
  }

  // ── Called by mcpAuthRouter's /token handler for refresh_token grant ──────────

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const payload = this.jwtService.verifyToken(refreshToken);
    if (!payload || payload.type !== "refresh") {
      throw new Error("Invalid or expired refresh token");
    }
    const tokenClientId = payload.client_id ?? payload.azp;
    if (tokenClientId !== client.client_id) {
      throw new Error("Refresh token does not belong to this client");
    }
    const resourceUrl =
      resource?.href ?? payload.resource ?? this.resourceUrl;
    return this.jwtService.generateTokenPair(
      payload.sub,
      client.client_id,
      resourceUrl,
      scopes?.join(" ") ?? payload.scope ?? "",
      payload.user_profile_id,
    );
  }

  // ── Called by requireBearerAuth middleware on every /mcp request ──────────────

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return this.jwtService.verifyAccessToken(token);
  }

  // ── Called by mcpAuthRouter's /revoke handler (stateless JWTs: no-op) ─────────

  async revokeToken(
    _client: OAuthClientInformationFull,
    _request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // JWTs are stateless; add a Redis blocklist here if revocation is needed.
  }

  // ── Called from the GET /auth/callback Express route ─────────────────────────

  async handleGoogleCallback(
    googleCode: string,
    sessionId: string,
  ): Promise<string> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error("Invalid or expired OAuth session");

    // Exchange Google authorisation code for a Google access token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: googleCode,
        client_id: this.googleClientId,
        client_secret: this.googleClientSecret,
        redirect_uri: `${this.serverUrl}/auth/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Google token exchange failed: ${body}`);
    }
    const tokenData = (await tokenRes.json()) as { access_token: string };

    // Fetch the user's Google profile
    const profileRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
    );
    if (!profileRes.ok) {
      throw new Error("Failed to fetch Google user profile");
    }
    const profile = (await profileRes.json()) as {
      id: string;
      email: string;
      name: string;
    };

    const userProfileId = await this.store.upsertUserProfile(
      {
        id: profile.id,
        username: profile.email,
        email: profile.email,
        displayName: profile.name,
      },
      "google",
    );

    // Issue our own short-lived authorisation code
    const authCode = randomBytes(32).toString("base64url");
    await this.store.storeAuthCode({
      code: authCode,
      client_id: session.clientId,
      redirect_uri: session.redirectUri,
      code_challenge: session.codeChallenge,
      code_challenge_method: session.codeChallengeMethod,
      user_id: profile.email,
      scope: session.scope,
      resource: session.resource,
      expires_at: Date.now() + AUTH_CODE_TTL_MS,
      user_profile_id: userProfileId,
    });

    await this.store.removeSession(sessionId);

    // Redirect back to the MCP client with the authorisation code
    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.set("code", authCode);
    if (session.oauthState) {
      redirectUrl.searchParams.set("state", session.oauthState);
    }
    return redirectUrl.toString();
  }
}
