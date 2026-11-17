// Local-only default that matches docker-compose.yml. It is not a secret; override it with DATABASE_URL.
const LOCAL_DEFAULT_DATABASE_URL = 'postgres://monetalab:monetalab_local_only@127.0.0.1:55432/monetalab';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? LOCAL_DEFAULT_DATABASE_URL;
}
