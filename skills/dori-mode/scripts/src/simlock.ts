import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "./run.ts";

// One simulator/xcodebuild run at a time, first come first served. Each waiter writes a ticket named
// <15-digit ms>-<pid>; the lexically first ticket owns the lock. Tickets of dead processes are removed.

export type SimlockDeps = {
  readonly dir: string;
  readonly clock: Clock;
  readonly alive: (pid: number) => boolean;
  readonly pid: number;
  readonly log: (line: string) => void;
  readonly pollMs?: number;
};

const ORPHAN_MS = 60_000;

const owner = (path: string): { readonly pid: number; readonly label: string } | null => {
  try {
    const [pid = "", ...label] = readFileSync(path, "utf8").trim().split(" ");
    return Number(pid) > 0 ? { pid: Number(pid), label: label.slice(0, -1).join(" ") } : null;
  } catch {
    return null;
  }
};

const queue = (deps: SimlockDeps): string[] => {
  const live: string[] = [];
  for (const name of readdirSync(deps.dir).filter((n) => /^\d{15}-\d+$/.test(n)).sort()) {
    const path = join(deps.dir, name);
    const who = owner(path);
    let stale = who ? !deps.alive(who.pid) : false;
    if (!who) {
      try {
        stale = deps.clock.now() - statSync(path).mtimeMs > ORPHAN_MS;
      } catch {
        continue;
      }
    }
    if (stale) {
      rmSync(path, { force: true });
      deps.log(`SIMLOCK removed stale ticket ${name}${who ? ` (pid ${who.pid} ${who.label} is gone)` : ""}`);
    } else live.push(name);
  }
  return live;
};

export const takeTicket = (deps: SimlockDeps, label: string): string => {
  mkdirSync(deps.dir, { recursive: true });
  const name = `${String(deps.clock.now()).padStart(15, "0")}-${deps.pid}`;
  const path = join(deps.dir, name);
  writeFileSync(path, `${deps.pid} ${label} ${new Date(deps.clock.now()).toISOString()}\n`);
  return path;
};

export const waitTurn = async (deps: SimlockDeps, ticket: string): Promise<void> => {
  const mine = ticket.split("/").pop() ?? "";
  let said = "";
  for (;;) {
    const q = queue(deps);
    const at = q.indexOf(mine);
    if (at < 0) throw new Error(`simlock ticket ${mine} disappeared`);
    if (at === 0) {
      deps.log(`SIMLOCK acquired ${mine}`);
      return;
    }
    const head = owner(join(deps.dir, q[0] ?? ""));
    const line = `SIMLOCK waiting: position ${at + 1} of ${q.length} (running: pid ${head?.pid ?? "?"} ${head?.label ?? ""})`.trimEnd();
    if (line !== said) deps.log((said = line));
    await deps.clock.sleep(deps.pollMs ?? 2_000);
  }
};

export const releaseTicket = (ticket: string): void => rmSync(ticket, { force: true });
