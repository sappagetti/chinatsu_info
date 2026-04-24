/** 長めの非同期処理中、一定間隔で経過秒をログしフリーズと誤認されないようにする */
export async function withElapsedLog<T>(
  log: (message: string) => void,
  label: string,
  fn: () => Promise<T>,
  intervalMs = 5000,
): Promise<T> {
  const t0 = Date.now();
  const iv = window.setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    log(`${label}… 処理中です（経過約 ${sec} 秒）`);
  }, intervalMs);
  try {
    return await fn();
  } finally {
    window.clearInterval(iv);
  }
}
