// Everything the console shows: lines from the Rust side (git, GitHub, AI,
// the preview proxy), lines from the interface (opened, saved, created), the
// timing of every backend call, and progress bars for steps in flight.

import { emit } from "./store";

export type Level = "debug" | "info" | "warn" | "error";
export type Source = "git" | "github" | "ai" | "preview" | "files" | "app" | "ipc";

export interface Progress {
  task: string;
  label: string;
  current: number;
  total: number;
  unit: string;
  done: boolean;
}

export interface LogEntry {
  id: number;
  time: number;
  level: Level;
  source: Source | string;
  message: string;
  repoId: string | null;
  /** How many times this same line arrived in a row. */
  count: number;
}

export interface ActiveTask extends Progress {
  repoId: string | null;
  source: string;
  started: number;
}

const MAX = 3000;
export const entries: LogEntry[] = [];
export const tasks = new Map<string, ActiveTask>();
let nextId = 1;
let unseen = 0;
let consoleOpen = false;
let pending = false;

/** Coalesce bursts (libgit2 can report many times a second) into one paint. */
function announce() {
  if (pending) return;
  pending = true;
  const run = () => {
    pending = false;
    emit("log");
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

export interface Incoming {
  level: Level;
  source: string;
  message: string;
  repoId?: string | null;
  progress?: Progress | null;
}

export function addLog(e: Incoming, time = Date.now()) {
  if (e.progress) {
    const p = e.progress;
    if (p.done) tasks.delete(p.task);
    else {
      const existing = tasks.get(p.task);
      tasks.set(p.task, { ...p, repoId: e.repoId ?? null, source: e.source, started: existing?.started ?? time });
    }
    announce();
    return;
  }
  const last = entries[entries.length - 1];
  // The same line again — a retried call, or one failure reported by both the
  // backend and the call that saw it — is counted, not repeated.
  if (last && last.message === e.message && last.level === e.level && (last.repoId ?? null) === (e.repoId ?? null) && time - last.time < 3000) {
    last.count++;
    last.time = time;
  } else {
    entries.push({ id: nextId++, time, level: e.level, source: e.source, message: e.message, repoId: e.repoId ?? null, count: 1 });
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    if (e.level === "error" && !consoleOpen) unseen++;
  }
  announce();
}

export const log = {
  debug: (source: Source, message: string, repoId?: string | null) => addLog({ level: "debug", source, message, repoId }),
  info: (source: Source, message: string, repoId?: string | null) => addLog({ level: "info", source, message, repoId }),
  warn: (source: Source, message: string, repoId?: string | null) => addLog({ level: "warn", source, message, repoId }),
  error: (source: Source, message: string, repoId?: string | null) => addLog({ level: "error", source, message, repoId }),
};

export function clearLog() {
  entries.length = 0;
  unseen = 0;
  announce();
}

export function unseenErrors(): number {
  return unseen;
}

export function setConsoleOpen(open: boolean) {
  consoleOpen = open;
  if (open) unseen = 0;
  announce();
}

export function timeLabel(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Plain text, for Copy: one line per entry, oldest first. */
export function asText(list: LogEntry[], repoName: (id: string) => string): string {
  return list
    .map((e) => `${timeLabel(e.time)} ${e.level.toUpperCase().padEnd(5)} ${e.source.padEnd(7)} ${e.repoId ? `[${repoName(e.repoId)}] ` : ""}${e.message}${e.count > 1 ? ` (×${e.count})` : ""}`)
    .join("\n");
}
