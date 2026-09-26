import os from "node:os";
import path from "node:path";

// ---- display helpers (no dependencies) ----
export const useColor =
  !process.env.NO_COLOR && (process.env.FORCE_COLOR || process.stdout.isTTY);

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};
export function paint(code, s) {
  return useColor ? `${code}${s}${C.reset}` : s;
}
export const palette = C;

// Derive a friendly repo label from a working directory path.
// SPEC §2.2: basename only; the home dir itself must not leak a username.
export function repoFromDir(dir) {
  if (!dir) return "(unknown)";
  const trimmed = dir.replace(/\/+$/, "");
  const home = os.homedir();
  if (trimmed === home || trimmed === "") return "~";
  return path.basename(trimmed);
}

export function fmtTokens(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtUSD(v) {
  if (v == null || Number.isNaN(v)) return "—";
  if (v < 0.01 && v > 0) return `<$0.01`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// A fixed-width horizontal bar scaled to max.
export function bar(frac, width = 24) {
  frac = Math.max(0, Math.min(1, frac || 0));
  const filled = Math.round(frac * width);
  const rest = "·".repeat(Math.max(0, width - filled));
  return "█".repeat(filled) + (useColor ? `${palette.gray}${rest}${palette.reset}` : rest);
}

export function truncate(s, n) {
  s = String(s ?? "");
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function pad(s, n) {
  s = truncate(s, n);
  return s + " ".repeat(Math.max(0, n - s.length));
}

export function dayFromMsOrIso(ts) {
  // accepts epoch-ms (OpenCode) or ISO string (Claude)
  if (ts == null) return "unknown";
  let d;
  if (typeof ts === "number") d = new Date(ts);
  else d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}
