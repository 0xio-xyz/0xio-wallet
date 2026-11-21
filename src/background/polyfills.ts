if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
}

// Some libs check process.env at import time
if (typeof (globalThis as any).process === 'undefined') {
  (globalThis as any).process = { env: {} };
}
