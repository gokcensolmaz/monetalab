import { expect, test } from './support/fixtures.ts';
import { bearer, expireSession, login, newUser, PASSWORD, register, sha256, uniqueEmail } from './support/helpers.ts';

// AUTH-01. Categories (D-005): [BR] business rule, [INT] integration, [NEG] negative/edge case.
// Spec numbers refer to docs/slice-3-plan.md §6.2 and §0.3 (specs 15–19).

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // D-S3-01, computed independently of the implementation
const USER_KEYS = ['createdAt', 'email', 'id'];

test.describe('AUTH-01 journeys', () => {
  test('[BR][AUTH-01] #1 register → login → /me → logout → /me is unauthorized', async ({ api }) => {
    const email = uniqueEmail();
    const reg = await api.post('/auth/register', { data: { email, password: PASSWORD } });
    expect(reg.status()).toBe(201);
    const registered = (await reg.json()).user;
    expect(registered.email).toBe(email);

    const loginRes = await api.post('/auth/login', { data: { email, password: PASSWORD } });
    expect(loginRes.status()).toBe(200);
    const { token, user } = await loginRes.json();
    expect(user.id).toBe(registered.id);

    const me = await api.get('/me', { headers: bearer(token) });
    expect(me.status()).toBe(200);
    expect((await me.json()).user).toEqual(registered);

    expect((await api.post('/auth/logout', { headers: bearer(token) })).status()).toBe(204);
    expect((await api.get('/me', { headers: bearer(token) })).status()).toBe(401);
  });

  test('[INT][AUTH-01] #2 registration stores a normalized email, a scrypt hash, and four zero buckets', async ({ api, db }) => {
    const local = `Mixed.Case-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { response } = await register(api, `  ${local}@Test.INVALID  `);
    expect(response.status()).toBe(201);
    const { user } = await response.json();
    const expectedEmail = `${local.toLowerCase()}@test.invalid`;
    expect(user.email).toBe(expectedEmail);

    const { rows } = await db.query('SELECT email, password_hash FROM users WHERE id = $1', [user.id]);
    expect(rows[0].email).toBe(expectedEmail);
    expect(rows[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);

    const buckets = await db.query(
      // Order by the enum column (declaration order), not by the text alias.
      'SELECT b.bucket::text AS bucket, b.balance FROM bucket_balances b WHERE b.user_id = $1 ORDER BY b.bucket',
      [user.id],
    );
    expect(buckets.rows).toEqual([
      { bucket: 'SUBSCRIPTION', balance: 0 },
      { bucket: 'CONSUMABLE', balance: 0 },
      { bucket: 'REWARD', balance: 0 },
      { bucket: 'PROMOTIONAL', balance: 0 },
    ]);
  });

  test('[INT][AUTH-01] #3 login stores only SHA-256(token) and an absolute 7-day expiry', async ({ api, db }) => {
    const user = await newUser(api);
    const loginRes = await api.post('/auth/login', { data: { email: user.email, password: PASSWORD } });
    const { token, expiresAt } = await loginRes.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { rows } = await db.query(
      `SELECT token_hash, created_at, expires_at, revoked_at, row_to_json(s)::text AS raw
         FROM sessions s WHERE user_id = $1 AND token_hash = $2`,
      [user.id, sha256(token)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).not.toContain(token);
    expect(rows[0].revoked_at).toBeNull();
    const ttl = rows[0].expires_at.getTime() - rows[0].created_at.getTime();
    expect(Math.abs(ttl - SEVEN_DAYS_MS)).toBeLessThan(5_000);
    expect(new Date(expiresAt).getTime()).toBe(rows[0].expires_at.getTime());
  });

  test('[NEG] #4 responses never expose passwords, hashes or session ids', async ({ api }) => {
    const email = uniqueEmail();
    const reg = await api.post('/auth/register', { data: { email, password: PASSWORD } });
    const loginRes = await api.post('/auth/login', { data: { email, password: PASSWORD } });
    const loginBody = await loginRes.json();
    const me = await api.get('/me', { headers: bearer(loginBody.token) });
    for (const body of [await reg.json(), loginBody, await me.json()]) {
      expect(Object.keys(body.user).sort()).toEqual(USER_KEYS);
      const text = JSON.stringify(body);
      for (const forbidden of [PASSWORD, 'password', 'hash', 'scrypt', 'session']) expect(text).not.toContain(forbidden);
    }
    expect(Object.keys(loginBody).sort()).toEqual(['expiresAt', 'token', 'user']);
  });
});

test.describe('registration rules', () => {
  test('[NEG][AUTH-01] #5 duplicate email, including case and whitespace variants, returns 409', async ({ api, db }) => {
    const email = uniqueEmail();
    expect((await register(api, email)).response.status()).toBe(201);
    for (const variant of [email, email.toUpperCase(), `  ${email}  `]) {
      const { response } = await register(api, variant);
      expect(response.status()).toBe(409);
      expect((await response.json()).error.code).toBe('EMAIL_ALREADY_REGISTERED');
    }
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE lower(email) = $1', [email]);
    expect(rows[0].n).toBe(1);
  });

  test('[NEG] #6 ten concurrent registrations of one email: exactly one 201, nine 409, no 5xx', async ({ api, db }) => {
    const email = uniqueEmail('race');
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => register(api, email)))).map((r) => r.response.status());
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    expect(rows[0].n).toBe(1);
  });

  const invalidBodies: Array<[string, unknown]> = [
    ['missing email', { password: PASSWORD }],
    ['missing password', { email: 'x@test.invalid' }],
    ['email without @', { email: 'not-an-email', password: PASSWORD }],
    ['email without domain dot', { email: 'a@b', password: PASSWORD }],
    ['email with spaces inside', { email: 'a b@test.invalid', password: PASSWORD }],
    ['email over 320 characters', { email: `${'a'.repeat(310)}@test.invalid`, password: PASSWORD }],
    ['7-character password', { email: 'x@test.invalid', password: 'a'.repeat(7) }],
    ['129-character password', { email: 'x@test.invalid', password: 'a'.repeat(129) }],
    ['7 emoji (14 UTF-16 units)', { email: 'x@test.invalid', password: '🔐'.repeat(7) }],
    ['numeric password', { email: 'x@test.invalid', password: 12345678 }],
    ['extra property', { email: 'x@test.invalid', password: PASSWORD, role: 'admin' }],
    ['array body', [PASSWORD]],
  ];
  for (const [label, data] of invalidBodies) {
    test(`[NEG] #8 register rejects ${label} with 400 VALIDATION_ERROR`, async ({ api }) => {
      const response = await api.post('/auth/register', { data: data as object });
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    });
  }

  test('[NEG] #8 malformed JSON returns 400, a non-JSON content type returns 415, and no user is created', async ({ api, db }) => {
    const email = uniqueEmail('malformed');
    const bad = await api.post('/auth/register', {
      headers: { 'content-type': 'application/json' },
      data: Buffer.from(`{"email":"${email}","password":`),
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('VALIDATION_ERROR');
    const form = await api.post('/auth/register', { form: { email, password: PASSWORD } });
    expect(form.status()).toBe(415);
    expect((await form.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    expect(rows[0].n).toBe(0);
  });

  test('[BR] password length boundaries: 8 and 128 characters (and 8 emoji) are accepted', async ({ api }) => {
    for (const password of ['a'.repeat(8), 'a'.repeat(128), '🔐'.repeat(8)]) {
      const { response, email } = await register(api, uniqueEmail('boundary'), password);
      expect(response.status()).toBe(201);
      expect(await login(api, email, password)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  test('[NEG] #16 bodies over 16 KB return 413 PAYLOAD_TOO_LARGE and create nothing', async ({ api, db }) => {
    const email = uniqueEmail('large');
    for (const path of ['/auth/register', '/auth/login']) {
      const response = await api.post(path, { data: { email, password: PASSWORD, padding: 'x'.repeat(17 * 1024) } });
      expect(response.status()).toBe(413);
      expect((await response.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
    }
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    expect(rows[0].n).toBe(0);
  });
});

test.describe('login rules', () => {
  test('[NEG][AUTH-01] #7 wrong password and unknown email give byte-identical 401s, and no session is created', async ({ api, db }) => {
    const user = await newUser(api);
    const wrong = await api.post('/auth/login', { data: { email: user.email, password: 'wrong password!' } });
    const unknown = await api.post('/auth/login', { data: { email: uniqueEmail('nobody'), password: PASSWORD } });
    expect(wrong.status()).toBe(401);
    expect(unknown.status()).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect((await wrong.json()).error.code).toBe('INVALID_CREDENTIALS');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [user.id]);
    expect(rows[0].n).toBe(1); // only the session from newUser()
  });

  test('[BR] login accepts the email in any case and with surrounding whitespace', async ({ api }) => {
    const user = await newUser(api);
    expect(await login(api, `  ${user.email.toUpperCase()} `)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('[NEG] login validation errors return 400', async ({ api }) => {
    for (const data of [{}, { email: 'x@test.invalid' }, { email: 'x@test.invalid', password: '' }, { email: 1, password: PASSWORD }]) {
      expect((await api.post('/auth/login', { data })).status()).toBe(400);
    }
  });
});

test.describe('bearer authentication', () => {
  test('[NEG][AUTH-01] #9 missing, non-Bearer, empty and unknown tokens get 401 + WWW-Authenticate', async ({ api }) => {
    const unknownToken = Buffer.alloc(32, 7).toString('base64url');
    for (const headers of [{}, { Authorization: 'Basic dXNlcjpwYXNz' }, { Authorization: 'Bearer' }, { Authorization: 'Bearer ' }, bearer(unknownToken)]) {
      const response = await api.get('/me', { headers });
      expect(response.status()).toBe(401);
      expect(response.headers()['www-authenticate']).toBe('Bearer');
      expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
    }
  });

  test('[NEG] #15 malformed tokens are all rejected with 401', async ({ api }) => {
    const { token } = await newUser(api);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const nonCanonical = token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1)!) + 1];
    const variants = [
      token.slice(0, 42),
      `${token}A`,
      `+${token.slice(1)}`,
      `/${token.slice(1)}`,
      `${token.slice(0, 42)}=`,
      nonCanonical,
      ` ${token}`, // becomes "Bearer  <token>" (two spaces)
      `${token} ${token}`,
      `${token}\tx`,
    ];
    for (const variant of variants) {
      const response = await api.get('/me', { headers: { Authorization: `Bearer ${variant}` } });
      expect(response.status(), `variant ${JSON.stringify(variant.slice(0, 8))}…`).toBe(401);
    }
    for (const header of [`Bearer  ${token}`, `Bearer\t${token}`, `Token ${token}`, token]) {
      expect((await api.get('/me', { headers: { Authorization: header } })).status()).toBe(401);
    }
  });

  test('[BR] trailing whitespace after the token is removed by HTTP itself (RFC 7230 §3.2.4), so it is the same token', async ({ api }) => {
    // Node's HTTP parser strips optional whitespace around header values before the app sees them.
    const { token } = await newUser(api);
    for (const header of [`Bearer ${token} `, `Bearer ${token}\t`]) {
      expect((await api.get('/me', { headers: { Authorization: header } })).status()).toBe(200);
    }
  });

  test('[BR] the Bearer scheme name is case-insensitive (RFC 7235)', async ({ api }) => {
    const { token } = await newUser(api);
    for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
      expect((await api.get('/me', { headers: { Authorization: `${scheme} ${token}` } })).status()).toBe(200);
    }
  });

  test('[NEG][AUTH-01] #10 a revoked token stays rejected; the session row is kept with revoked_at set', async ({ api, db }) => {
    const user = await newUser(api);
    expect((await api.post('/auth/logout', { headers: bearer(user.token) })).status()).toBe(204);
    expect((await api.get('/me', { headers: bearer(user.token) })).status()).toBe(401);
    expect((await api.post('/auth/logout', { headers: bearer(user.token) })).status()).toBe(401);
    const { rows } = await db.query('SELECT revoked_at FROM sessions WHERE user_id = $1 AND token_hash = $2', [user.id, sha256(user.token)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  test('[BR][AUTH-01] #11 logout revokes only the current session', async ({ api }) => {
    const user = await newUser(api);
    const second = await login(api, user.email);
    expect((await api.post('/auth/logout', { headers: bearer(user.token) })).status()).toBe(204);
    expect((await api.get('/me', { headers: bearer(user.token) })).status()).toBe(401);
    expect((await api.get('/me', { headers: bearer(second) })).status()).toBe(200);
  });

  test('[NEG][AUTH-01] #12 an expired session is rejected', async ({ api, db }) => {
    const user = await newUser(api);
    expect((await api.get('/me', { headers: bearer(user.token) })).status()).toBe(200);
    await expireSession(db, user);
    expect((await api.get('/me', { headers: bearer(user.token) })).status()).toBe(401);
  });

  test('[NEG] #17 logout with an expired session returns 401 and does not revoke it', async ({ api, db }) => {
    const user = await newUser(api);
    await expireSession(db, user);
    expect((await api.post('/auth/logout', { headers: bearer(user.token) })).status()).toBe(401);
    const { rows } = await db.query('SELECT revoked_at FROM sessions WHERE user_id = $1 AND token_hash = $2', [user.id, sha256(user.token)]);
    expect(rows[0].revoked_at).toBeNull();
  });

  test('[NEG][AUTH-01] #13 each token resolves only to its own user', async ({ api }) => {
    const [x, y] = await Promise.all([newUser(api, 'x'), newUser(api, 'y')]);
    const meX = (await (await api.get('/me', { headers: bearer(x.token) })).json()).user;
    const meY = (await (await api.get('/me', { headers: bearer(y.token) })).json()).user;
    expect([meX.id, meX.email]).toEqual([x.id, x.email]);
    expect([meY.id, meY.email]).toEqual([y.id, y.email]);
    expect(meX.id).not.toBe(meY.id);
  });

  test('[NEG] #14 auth responses are not cacheable', async ({ api }) => {
    const email = uniqueEmail();
    await register(api, email);
    const loginRes = await api.post('/auth/login', { data: { email, password: PASSWORD } });
    const me = await api.get('/me', { headers: bearer((await loginRes.json()).token) });
    for (const response of [loginRes, me]) {
      expect(response.headers()['cache-control']).toBe('no-store');
      expect(response.headers()['x-content-type-options']).toBe('nosniff');
    }
  });

  test('[BR] #18 ten parallel logins create ten distinct, independently valid sessions', async ({ api }) => {
    const user = await newUser(api);
    const tokens = await Promise.all(Array.from({ length: 10 }, () => login(api, user.email)));
    expect(new Set(tokens).size).toBe(10);
    const statuses = await Promise.all(tokens.map(async (t) => (await api.get('/me', { headers: bearer(t) })).status()));
    expect(statuses).toEqual(Array(10).fill(200));
    expect((await api.post('/auth/logout', { headers: bearer(tokens[0]!) })).status()).toBe(204);
    const after = await Promise.all(tokens.map(async (t) => (await api.get('/me', { headers: bearer(t) })).status()));
    expect(after).toEqual([401, ...Array(9).fill(200)]);
  });

  test('[NEG] #19 ten concurrent logouts of one token: exactly one 204, the rest 401', async ({ api }) => {
    const user = await newUser(api);
    const statuses = await Promise.all(
      Array.from({ length: 10 }, async () => (await api.post('/auth/logout', { headers: bearer(user.token) })).status()),
    );
    expect(statuses.filter((s) => s === 204)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(9);
  });
});
