// Hybrid routing policy.
//
// Rule (from the project brief): try the on-device model first; use the cloud
// when the input is long or complex, or when the local model is unavailable.
//
// This module is deliberately dependency-free so the policy can be unit tested
// without a browser or Firebase.

export const DEFAULT_POLICY = {
  // A short spoken question fits comfortably in Gemini Nano's context.
  maxOnDeviceChars: 240,
  maxOnDeviceWords: 45,
  // Cloud model used for the fallback / complex path. Overridable with
  // Firebase Remote Config (key: cloudModel).
  cloudModel: "gemini-3.7-flash",
  // Phrases that signal reasoning, long-form writing, or code. Gemini Nano is
  // tuned for short, local tasks, so these go to the cloud.
  complexPhrases: [
    "step by step",
    "step-by-step",
    "in detail",
    "explain why",
    "explain how",
    "compare",
    "contrast",
    "analyse",
    "analyze",
    "essay",
    "write a",
    "draft a",
    "brainstorm",
    "outline",
    "research",
    "prove",
    "derive",
    "calculate",
    "algorithm",
    "code",
    "function",
    "debug",
    "regex",
    "sql",
    "translate this",
    "summarize this document",
  ],
};

const WORD = /\s+/;

/**
 * Decide where one request should run.
 *
 * @param {string} input raw user text (transcribed or typed)
 * @param {{
 *   online?: boolean,
 *   deviceReady?: boolean,
 *   historyChars?: number,
 *   policy?: Partial<typeof DEFAULT_POLICY>
 * }} ctx
 * @returns {{
 *   target: "on-device" | "cloud" | "none",
 *   mode: "prefer_on_device" | "only_in_cloud" | "none",
 *   reason: string,
 *   chars: number,
 *   words: number
 * }}
 */
export function decideRoute(input, ctx = {}) {
  const policy = { ...DEFAULT_POLICY, ...(ctx.policy || {}) };
  const text = String(input ?? "").trim();
  const words = text ? text.split(WORD).filter(Boolean).length : 0;
  const historyChars = Math.max(0, ctx.historyChars || 0);
  const chars = text.length + historyChars;
  const online = ctx.online !== false;
  const deviceReady = ctx.deviceReady === true;

  if (!words) {
    return { target: "none", mode: "none", reason: "There was no speech to send.", chars, words };
  }

  // Offline: only the local model can answer.
  if (!online) {
    if (deviceReady) {
      return {
        target: "on-device",
        mode: "prefer_on_device",
        reason: "Offline — answered by the local model.",
        chars,
        words,
      };
    }
    return {
      target: "none",
      mode: "none",
      reason: "Offline and the on-device model isn't ready on this device.",
      chars,
      words,
    };
  }

  if (chars > policy.maxOnDeviceChars) {
    return {
      target: "cloud",
      mode: "only_in_cloud",
      reason: `Long input (${chars} chars > ${policy.maxOnDeviceChars}) — sent to the cloud model.`,
      chars,
      words,
    };
  }

  if (words > policy.maxOnDeviceWords) {
    return {
      target: "cloud",
      mode: "only_in_cloud",
      reason: `Long input (${words} words > ${policy.maxOnDeviceWords}) — sent to the cloud model.`,
      chars,
      words,
    };
  }

  const lower = text.toLowerCase();
  const marker = policy.complexPhrases.find((p) => lower.includes(p));
  if (marker) {
    return {
      target: "cloud",
      mode: "only_in_cloud",
      reason: `Complex task ("${marker}") — sent to the cloud model.`,
      chars,
      words,
    };
  }

  // Multi-line input or pasted code is a code/reasoning task.
  if (text.split("\n").length > 2 || text.includes("```")) {
    return {
      target: "cloud",
      mode: "only_in_cloud",
      reason: "Multi-line or code input — sent to the cloud model.",
      chars,
      words,
    };
  }

  if (!deviceReady) {
    return {
      target: "cloud",
      mode: "only_in_cloud",
      reason: "On-device model unavailable here — using the cloud.",
      chars,
      words,
    };
  }

  return {
    target: "on-device",
    mode: "prefer_on_device",
    reason: "Short and simple — tried on-device first.",
    chars,
    words,
  };
}
