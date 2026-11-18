/**
 * Bearer authentication guard (slice 3 plan §4.2). Reused by every authenticated route.
 * Missing, malformed, unknown, expired and revoked tokens all produce the same 401 UNAUTHENTICATED.
 * Validity is evaluated with the database clock: revoked_at IS NULL AND expires_at > now().
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { unauthenticated } from '../http/errors.ts';
import { hashToken, isWellFormedToken } from './tokens.ts';

export type AuthUser = { id: string; email: string; createdAt: string };
export type AuthContext = { sessionId: string; user: AuthUser };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const BEARER = /^Bearer ([^\s]+)$/i; // scheme is case-insensitive (RFC 7235); exactly one space, no extra parts

export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = BEARER.exec(header);
  if (!match || !isWellFormedToken(match[1])) return null;
  return match[1]!;
}

export function requireAuth(pool: pg.Pool) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthenticated();
    const { rows } = await pool.query<{ session_id: string; user_id: string; email: string; created_at: Date }>(
      `SELECT s.id AS session_id, u.id AS user_id, u.email, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) throw unauthenticated();
    request.auth = {
      sessionId: row.session_id,
      user: { id: row.user_id, email: row.email, createdAt: row.created_at.toISOString() },
    };
  };
}

/** For handlers behind requireAuth. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}
