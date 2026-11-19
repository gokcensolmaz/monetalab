/**
 * AUTH-01 routes (D-S3-01..07): register, login, logout, me.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUniqueViolation } from '../db/tx.ts';
import { ApiError, unauthenticated } from '../http/errors.ts';
import { hashPassword, isPasswordWithinPolicy, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from './password.ts';
import { authOf, requireAuth, type AuthUser } from './require-auth.ts';
import { newSessionToken } from './tokens.ts';

export const SESSION_TTL_DAYS = 7; // D-S3-01 (absolute, no sliding renewal)
const EMAIL_MAX_LENGTH = 320;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** D-S3-05: trim and lowercase. Returns null when not a plausible email address. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

const credentialsBody = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 1, maxLength: 400 },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

type Credentials = { email: string; password: string };
type UserRow = { id: string; email: string; created_at: Date; password_hash?: string };

const toUser = (row: UserRow): AuthUser => ({ id: row.id, email: row.email, createdAt: row.created_at.toISOString() });

let dummyHash: Promise<string> | undefined;
/** A real hash of a random password, so logins for unknown emails cost the same scrypt work. */
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}

export function registerAuthRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const guard = requireAuth(pool);

  app.post<{ Body: Credentials }>('/auth/register', { schema: { body: credentialsBody } }, async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    if (!email) throw new ApiError(400, 'VALIDATION_ERROR', 'A valid email address is required');
    if (!isPasswordWithinPolicy(request.body.password)) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
      );
    }
    const passwordHash = await hashPassword(request.body.password);
    try {
      const { rows } = await pool.query<UserRow>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
        [email, passwordHash],
      );
      return reply.code(201).send({ user: toUser(rows[0]!) });
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_lower_uq')) {
        throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
      }
      throw error;
    }
  });

  app.post<{ Body: Credentials }>('/auth/login', { schema: { body: credentialsBody } }, async (request) => {
    const invalid = () => new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    const email = normalizeEmail(request.body.email);
    const { rows } = email
      ? await pool.query<UserRow>('SELECT id, email, created_at, password_hash FROM users WHERE lower(email) = $1', [email])
      : { rows: [] as UserRow[] };
    const user = rows[0];
    // Always run one scrypt verification so unknown emails take about as long as wrong passwords.
    const ok = await verifyPassword(request.body.password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) throw invalid();

    const { token, tokenHash } = newSessionToken();
    const session = await pool.query<{ expires_at: Date }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING expires_at`,
      [user.id, tokenHash, SESSION_TTL_DAYS],
    );
    return { token, expiresAt: session.rows[0]!.expires_at.toISOString(), user: toUser(user) };
  });

  app.get('/me', { onRequest: guard }, async (request) => ({ user: authOf(request).user }));

  app.post('/auth/logout', { onRequest: guard }, async (request, reply) => {
    // Revoke only this session. The conditions make concurrent or repeated logouts revoke exactly once.
    const { rowCount } = await pool.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [authOf(request).sessionId],
    );
    if (rowCount !== 1) throw unauthenticated();
    return reply.code(204).send();
  });
}
