import type pg from 'pg';

/** Returns true when the database answers a trivial query within `timeoutMs`. */
export async function pingDatabase(pool: pg.Pool, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const ping = pool.query('SELECT 1').then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
