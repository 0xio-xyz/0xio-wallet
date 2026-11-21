const IS_DEV = (() => {
  try {
    return !('update_url' in chrome.runtime.getManifest());
  } catch {
    return true;
  }
})();

let forceDebug = false;
try {
  chrome.storage?.local.get('debug_logs').then((r) => {
    forceDebug = r?.debug_logs === true;
  });
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'debug_logs' in changes) {
      forceDebug = changes.debug_logs.newValue === true;
    }
  });
} catch {}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export const logger = {
  debug: (...args: any[]) => {
    if (IS_DEV || forceDebug) console.log(`[${ts()}]`, ...args);
  },
  info: (...args: any[]) => console.log(`[${ts()}]`, ...args),
  warn: (...args: any[]) => console.warn(`[${ts()}]`, ...args),
  error: (...args: any[]) => console.error(`[${ts()}]`, ...args),
};
