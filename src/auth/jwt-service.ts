import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const ACCESS_TOKEN_EXPIRES_IN = "7d";
const REFRESH_TOKEN_EXPIRES_IN = "90d";
const ACCESS_TOKEN_SECONDS = 7 * 24 * 3600; // 7 days

export type TokenPayload = {
  sub: string;
  azp: string;
  iss: string;
  aud: string;
  resource: string;
  type: "access" | "refresh";
  scope?: string;
  jti?: string;
  client_id?: string;
  user_profile_id?: string;
  exp?: number;
};

export class JwtService {
  private readonly secret: string;
  private readonly issuer: string;

  constructor(secret: string, issuer: string) {
    if (!secret) throw new Error("MCP_JWT_SECRET must be set");
    this.secret = secret;
    this.issuer = issuer;
  }

  generateTokenPair(
    userId: string,
    clientId: string,
    resource: string,
    scope = "",
    userProfileId?: string,
  ): OAuthTokens {
    const jti = randomBytes(16).toString("hex");

    const accessPayload: TokenPayload = {
      sub: userId,
      azp: clientId,
      iss: this.issuer,
      aud: resource,
      resource,
      type: "access",
      scope,
      jti,
      ...(userProfileId ? { user_profile_id: userProfileId } : {}),
    };
    const accessToken = jwt.sign(accessPayload, this.secret, {
      algorithm: "HS256",
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    });

    const refreshPayload: TokenPayload = {
      sub: userId,
      azp: clientId,
      client_id: clientId,
      iss: this.issuer,
      aud: resource,
      resource,
      type: "refresh",
      scope,
      jti: `refresh_${jti}`,
      ...(userProfileId ? { user_profile_id: userProfileId } : {}),
    };
    const refreshToken = jwt.sign(refreshPayload, this.secret, {
      algorithm: "HS256",
      expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
    };
  }

  verifyToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, this.secret, {
        algorithms: ["HS256"],
      }) as TokenPayload;
    } catch (err) {
      const name = err instanceof Error ? err.constructor.name : "UnknownError";
      const msg  = err instanceof Error ? err.message : String(err);
      console.error(`[DEBUG][jwt] verifyToken failed — ${name}: ${msg} (token prefix: ${token.slice(0, 20)}...)`);
      return null;
    }
  }

  verifyAccessToken(token: string): AuthInfo {
    console.error(`[DEBUG][jwt] verifyAccessToken called (token prefix: ${token.slice(0, 20)}...)`);
    const payload = this.verifyToken(token);
    if (!payload) throw new Error("Invalid or expired token");
    if (payload.type !== "access") {
      console.error(`[DEBUG][jwt] token type mismatch — expected "access", got "${payload.type}"`);
      throw new Error("Not an access token");
    }
    console.error(`[DEBUG][jwt] token OK — sub: ${payload.sub}, azp: ${payload.azp}, exp: ${payload.exp ? new Date(payload.exp * 1000).toISOString() : "none"}`);

    return {
      token,
      clientId: payload.azp || payload.client_id || "",
      scopes: payload.scope
        ? payload.scope.split(" ").filter(Boolean)
        : [],
      expiresAt: payload.exp,
      ...(payload.resource ? { resource: new URL(payload.resource) } : {}),
    };
  }
}
