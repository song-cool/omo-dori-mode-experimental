import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

import type { Clock, Runner } from "./run.ts";

export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string };

export const psTable = async (run: Runner): Promise<Proc[] | null> => {
  const r = await run(["ps", "-axo", "pid=,ppid=,command="]);
  if (r.code !== 0) return null;
  return r.out.split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? "" }] : [];
  });
};

// lsof -F prints "p<pid>" then one "n<name>" per file. lsof exits 1 when some processes were unreadable, so keep its output.
const lsofPairs = (out: string): Array<readonly [number, string]> => {
  const pairs: Array<readonly [number, string]> = [];
  let pid = 0;
  for (const l of out.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && pid) pairs.push([pid, l.slice(1)]);
  }
  return pairs;
};

export const cwdTable = async (run: Runner): Promise<Map<number, string>> => new Map(lsofPairs((await run(["lsof", "-nP", "-w", "-d", "cwd", "-Fpn"])).out));

export const listeningPorts = async (run: Runner): Promise<Map<number, string[]>> => {
  const ports = new Map<number, string[]>();
  for (const [pid, name] of lsofPairs((await run(["lsof", "-nP", "-w", "-iTCP", "-sTCP:LISTEN", "-Fpn"])).out)) {
    const port = `:${name.split(":").pop() ?? ""}`;
    const list = ports.get(pid) ?? [];
    if (!list.includes(port)) ports.set(pid, [...list, port]);
  }
  return ports;
};

export const shellPid = async (run: Runner, pane: string): Promise<number | null> => {
  const r = await run(["herdr", "pane", "process-info", "--pane", pane]);
  if (r.code !== 0) return null;
  try {
    const pid = (JSON.parse(r.out) as { result?: { process_info?: { shell_pid?: number } } }).result?.process_info?.shell_pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
};

export const descendants = (table: readonly Proc[], roots: Iterable<number>): Set<number> => {
  const out = new Set<number>(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table) if (!out.has(p.pid) && out.has(p.ppid)) (out.add(p.pid), (grew = true));
  }
  return out;
};

export const ancestors = (table: readonly Proc[], pid: number): Set<number> => {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const out = new Set<number>();
  for (let at = byPid.get(pid); at && !out.has(at.pid); at = byPid.get(at.ppid)) out.add(at.pid);
  out.add(pid);
  return out;
};

export const within = (path: string, root: string): boolean => Boolean(path && root) && (path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`));

export const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

// herdr and the lead's own dori sweeps are never leftovers; config.leftoverKeep adds more (a messenger gateway, a watchdog).
const ALWAYS_KEPT = /\bherdr\b|\bdori (watch|freshness|inbound|presence|guard|dead-panes|close)\b/;

export const keptCommand = (patterns: readonly string[]): ((cmd: string) => boolean) => {
  const extra = patterns.map((p) => new RegExp(p));
  return (cmd) => ALWAYS_KEPT.test(cmd) || extra.some((r) => r.test(cmd));
};

// A root this shallow (/, /home, /home/me) would match far too much.
const deepEnough = (root: string): boolean => root.split("/").filter(Boolean).length >= 3;

// A directory under a worktree root counts as the lane's when its name contains the lane key and no longer open lane key.
export const matchingWorktreeDirs = (roots: readonly string[], key: string, otherKeys: readonly string[], listDir: (dir: string) => string[] = safeList): string[] => {
  const longer = otherKeys.filter((k) => k !== key && k.includes(key));
  return roots.flatMap((root) => listDir(root).filter((name) => name.includes(key) && !longer.some((k) => name.includes(k))).map((name) => join(root, name)));
};

const safeList = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

export type LeftoverInput = {
  readonly table: readonly Proc[];
  readonly cwds: ReadonlyMap<number, string>;
  readonly laneTree: readonly Proc[];
  readonly roots: readonly string[];
  readonly protectedPids: ReadonlySet<number>;
  readonly kept: (cmd: string) => boolean;
};

// A process belongs to the lane when it was in the lane pane's process tree before the pane closed (same pid and
// command, so a reused pid is not mistaken for it) or its cwd is inside one of the lane's own roots.
export const pickLeftovers = (input: LeftoverInput): Proc[] => {
  const tree = new Map(input.laneTree.map((p) => [p.pid, p.cmd]));
  const roots = input.roots.filter(deepEnough);
  return input.table.filter((p) => p.pid > 1 && !input.protectedPids.has(p.pid) && !input.kept(p.cmd) && (tree.get(p.pid) === p.cmd || roots.some((r) => within(input.cwds.get(p.pid) ?? "", r))));
};

export const privateCwd = (cwd: string | undefined, shared: readonly string[]): string[] => (cwd && deepEnough(cwd) && !shared.some((s) => overlaps(cwd, s)) ? [cwd] : []);

const short = (cmd: string): string => {
  const [head = "", ...rest] = cmd.split(" ");
  return [basename(head), ...rest].join(" ").slice(0, 80);
};

export const killLeftovers = async (run: Runner, clock: Clock, procs: readonly Proc[], ports: ReadonlyMap<number, string[]>): Promise<string[]> => {
  if (!procs.length) return [];
  await run(["kill", "-TERM", ...procs.map((p) => String(p.pid))]);
  await clock.sleep(1500);
  const after = (await psTable(run)) ?? [];
  const stubborn = new Set(procs.filter((p) => after.some((a) => a.pid === p.pid && a.cmd === p.cmd)).map((p) => p.pid));
  if (stubborn.size) await run(["kill", "-KILL", ...[...stubborn].map(String)]);
  return procs.map((p) => `killed ${p.pid} ${short(p.cmd)}${ports.get(p.pid)?.length ? ` (listening ${ports.get(p.pid)?.join(",")})` : ""}${stubborn.has(p.pid) ? " with SIGKILL" : ""}`);
};

const developerDir = (): string | null => {
  if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR;
  const app = safeList("/Applications").filter((n) => /^Xcode.*\.app$/.test(n)).sort().at(-1);
  return app ? `/Applications/${app}/Contents/Developer` : null;
};

// xcrun simctl fails when xcode-select points at the Command Line Tools, so retry with an installed Xcode.
export const simctl = async (run: Runner, args: readonly string[]): Promise<{ readonly code: number; readonly out: string }> => {
  const plain = await run(["xcrun", "simctl", ...args]);
  if (plain.code === 0) return plain;
  const dir = developerDir();
  return dir ? run(["/usr/bin/env", `DEVELOPER_DIR=${dir}`, "xcrun", "simctl", ...args]) : plain;
};

export const bootedSims = async (run: Runner): Promise<string[] | null> => {
  const r = await simctl(run, ["list", "devices", "booted", "-j"]);
  if (r.code !== 0) return null;
  try {
    const devices = (JSON.parse(r.out) as { devices?: Record<string, Array<{ udid: string; state: string }>> }).devices ?? {};
    return Object.values(devices).flat().filter((d) => d.state === "Booted").map((d) => d.udid);
  } catch {
    return null;
  }
};
