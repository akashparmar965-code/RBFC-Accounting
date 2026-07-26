// Keeps an upload-and-process page's results (parsed/computed data, not
// the raw File object — those can't be serialized) alive in sessionStorage
// across tab switches and page reloads within the same browser session, so
// switching pages doesn't wipe out work in progress. Cleared on sign-out
// (see clearAllPageState, called from Sidebar).
const PREFIX = "rbfc_pagestate_";

function isBrowser() {
  return typeof window !== "undefined";
}

export function savePageState(key, state) {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(state));
  } catch {
    // sessionStorage full/unavailable (e.g. private browsing) — state just
    // won't persist; not worth surfacing an error for.
  }
}

export function loadPageState(key) {
  if (!isBrowser()) return null;
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearPageState(key) {
  if (!isBrowser()) return;
  window.sessionStorage.removeItem(PREFIX + key);
}

export function clearAllPageState() {
  if (!isBrowser()) return;
  for (const k of Object.keys(window.sessionStorage)) {
    if (k.startsWith(PREFIX)) window.sessionStorage.removeItem(k);
  }
}
