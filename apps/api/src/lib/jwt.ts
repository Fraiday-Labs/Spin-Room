import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export type TokenType = 'access' | 'exchange' | 'mcp';

export interface AccessClaims extends JWTPayload {
  sub: string;
  typ: TokenType;
  sid?: string;
  /** Surface the token acts for (web, slack, mcp). */
  srf?: 'web' | 'slack' | 'mcp';
  /** api_tokens.id for MCP OAuth grants (revocable). */
  gid?: string;
}

export class Jwt {
  private readonly key: Uint8Array;
  constructor(secret: string, private readonly issuer = 'spinroom') {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: AccessClaims, audience: string, ttlSec: number): Promise<{ token: string; expiresAt: number }> {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: exp * 1000 };
  }

  async verify(token: string, audience: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: this.issuer, audience });
      if (typeof payload.sub !== 'string') return null;
      return payload as AccessClaims;
    } catch {
      return null;
    }
  }
}

export const API_AUDIENCE = 'spinroom-api';
