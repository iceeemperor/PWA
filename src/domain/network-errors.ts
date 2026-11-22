/**
 * The texts browsers give a fetch that never got a response (Safari "Load failed", Chrome "Failed to fetch", Firefox
 * "NetworkError when attempting to fetch resource.", React Native "Network request failed"), and the abort/timeout
 * names. postgrest-js turns such a failure into `{ message: "TypeError: Load failed", status: 0 }`.
 */
export const NETWORK_ERROR_PATTERN = /load failed|failed to fetch|networkerror|network request failed|aborterror|timeouterror/i;

/** True when the text reads like a request that never reached the server (for example a stored failure reason). */
export function isNetworkLikeMessage(message: string): boolean {
  return NETWORK_ERROR_PATTERN.test(message);
}
