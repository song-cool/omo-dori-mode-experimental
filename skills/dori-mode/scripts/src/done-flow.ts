import { existsSync } from "node:fs";

import { type DoriConfig, fill } from "./config.ts";
import { type Lane, type Registry, statusOf, withStatus } from "./registry.ts";
import { type Clock, iso, type Runner } from "./run.ts";
import { ancestors, bootedSims, cwdTable, descendants, keptCommand, killLeftovers, listeningPorts, matchingWorktreeDirs, overlaps, pickLeftovers, privateCwd, type Proc, psTable, shellPid, simctl } from "./leftovers.ts";
import { listPanes, type Pane, sendVerified } from "./panes.ts";
import { checkDone, type SignalIo } from "./signals.ts";

export type FlowDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  readonly exists?: (path: string) => boolean;
  readonly signalIo?: SignalIo;
  readonly selfPid?: number;
  readonly listDir?: (dir: string) => string[];
};

const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({ cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });

const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const at = iso(deps.clock);
  await deps.registry.write(withStatus(lane, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false } }));
  if (lane.pane) {
    const closesAt = new Date(deps.clock.now() + windowMs(deps)).toISOString().slice(11, 16);
    await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] done claim recorded for ${lane.key}: this lane closes automatically at ${closesAt}Z (${deps.config.closeAfterMin} minutes) unless the lead objects with reasons. Stay idle until then; an objection arrives here as [LEAD] not done.`);
  }
  return `LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${evidence}`;
};

export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  const at = iso(deps.clock);
  await deps.registry.write(withStatus(lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } }));
  if (lane.pane) await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] not done: ${reasons.join("; ")}; keep working, claim again when fixed`);
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};

export const discoverWorktrees = async (lane: Lane, run: Runner, extraRoots: readonly string[] = []): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch ") && path !== root && (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))) found.add(path);
    }
  }
  return [...found];
};

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  for (const wt of await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])) {
    if (!exists(wt)) continue;
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=no"]);
    const ahead = await deps.run(["git", "-C", wt, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};

const laneTree = async (deps: FlowDeps, lane: Lane): Promise<Proc[]> => {
  if (!lane.pane) return [];
  const table = await psTable(deps.run);
  const shell = await shellPid(deps.run, lane.pane);
  if (!table || shell === null) return [];
  const ids = descendants(table, [shell]);
  return table.filter((p) => ids.has(p.pid));
};

// Kills what the lane's children left running (dev servers, watchers) and shuts down the simulators it booted.
// Anything in another pane's process tree, the closer's own ancestry, or another open lane's directory is never touched.
const cleanupLeftovers = async (deps: FlowDeps, lane: Lane, before: readonly Proc[], worktrees: readonly string[]): Promise<string[]> => {
  const table = await psTable(deps.run);
  if (!table) return ["leftover scan skipped: ps failed"];
  let panes: Pane[];
  try {
    panes = (await listPanes(deps.run)).filter((p) => p.pane_id !== lane.pane);
  } catch {
    return ["leftover scan skipped: herdr pane list failed"];
  }
  const shells: number[] = [];
  for (const p of panes) {
    const shell = await shellPid(deps.run, p.pane_id);
    if (shell === null) return [`leftover scan skipped: could not read the processes of pane ${p.pane_id}`];
    shells.push(shell);
  }
  const others = (await deps.registry.open()).filter((l) => l.key !== lane.key);
  const protectedPids = new Set([...descendants(table, shells), ...ancestors(table, deps.selfPid ?? process.pid)]);
  const shared = [deps.config.defaultCwd, ...others.map((l) => l.cwd ?? ""), ...panes.map((p) => p.cwd ?? "")].filter(Boolean);
  const roots = [...worktrees, ...matchingWorktreeDirs(deps.config.worktreeRoots, lane.key, others.map((l) => l.key), deps.listDir), ...privateCwd(lane.cwd, shared)].filter((r) => !others.some((l) => l.cwd && overlaps(r, l.cwd)));
  const procs = pickLeftovers({ table, cwds: await cwdTable(deps.run), laneTree: before, roots, protectedPids, kept: keptCommand(deps.config.leftoverKeep) });
  const lines = await killLeftovers(deps.run, deps.clock, procs, await listeningPorts(deps.run));
  if (lane.simsAtLaunch) {
    const atLaunch = lane.simsAtLaunch;
    const mine = ((await bootedSims(deps.run)) ?? []).filter((u) => !atLaunch.includes(u));
    if (mine.length && others.length) lines.push(`simulators kept, other lanes are running: ${mine.join(", ")}`);
    else for (const u of mine) lines.push((await simctl(deps.run, ["shutdown", u])).code === 0 ? `simulator ${u} shut down` : `simulator ${u} not shut down`);
  }
  return lines.length ? lines : ["no leftover processes"];
};

export const closeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const exists = deps.exists ?? existsSync;
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  if (checks.some((c) => !c.ok)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live`] };
  const cleanup: string[] = [];
  const hook = deps.config.hooks.threadDone;
  if (hook && lane.thread !== "none") {
    const r = await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }));
    cleanup.push(r.code === 0 ? "thread marked done" : `thread hook failed: ${r.err.slice(0, 160)}`);
  }
  const statusHook = deps.config.hooks.threadStatus;
  if (statusHook && lane.thread !== "none") {
    // The hook may decline (for example, the thread is waiting on an owner decision): a first line starting KEPT says so.
    const r = await deps.run(fill(statusHook, { thread: lane.thread, status: "done", key: lane.key }));
    const said = r.out.split("\n")[0] ?? "";
    cleanup.push(r.code !== 0 ? `thread status hook failed: ${(r.err || r.out).slice(0, 160)}` : said.startsWith("KEPT") ? `thread status kept: ${said.slice(4).trim().slice(0, 120)}` : `thread status: ${said.slice(0, 120)}`);
  }
  const before = await laneTree(deps, lane);
  if (lane.tab) cleanup.push((await deps.run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`);
  else if (lane.pane) cleanup.push((await deps.run(["herdr", "pane", "close", lane.pane])).code === 0 ? `pane ${lane.pane} closed` : `pane ${lane.pane} not closed`);
  const root = lane.cwd ?? deps.config.defaultCwd;
  const worktrees = await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd]);
  cleanup.push(...(await cleanupLeftovers(deps, lane, before, worktrees)));
  for (const wt of worktrees.filter(exists)) {
    const r = await deps.run(["git", "-C", root, "worktree", "remove", wt]);
    cleanup.push(r.code === 0 ? `worktree ${wt} removed` : `worktree ${wt} kept: ${r.err.slice(0, 120)}`);
  }
  const at = iso(deps.clock);
  const receipt = { checks, note, cleanup };
  await deps.registry.write(withStatus(lane, "closed", note, at, { closedAt: at, receipt }));
  return { closed: true, lines: [...lines, `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};

const settle = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const blocked = await unpushedWork(deps, lane);
  if (blocked.length) return objectDone(deps, lane, blocked);
  const failing = (await checkDone(lane.done, deps.run, signalIo(deps, lane))).filter((c) => !c.ok).map((c) => `${c.signal} -> ${c.detail}`);
  if (failing.length) return objectDone(deps, lane, failing);
  const verified = withStatus(lane, "verified-done", "Done signals read back live", iso(deps.clock));
  await deps.registry.write(verified);
  const result = await closeLane(deps, verified, `Done: ${evidence}`);
  if (!result.closed) return objectDone(deps, (await deps.registry.read(lane.key)) ?? verified, result.lines.filter((l) => l.startsWith("SIGNAL NOT")));
  return `LANE_CLOSED ${lane.key} ${result.lines.at(-1)?.split(" ").slice(2).join(" ") ?? ""}`;
};

export const watchTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const listed of await deps.registry.list()) {
    if (statusOf(listed) !== "done-claimed" || !listed.claim) continue;
    let lane = listed;
    const claim = listed.claim;
    if (!claim.emitted) {
      out.push(`LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${claim.evidence}`);
      lane = { ...lane, claim: { ...claim, emitted: true } };
      await deps.registry.write(lane);
    }
    if (deps.clock.now() - Date.parse(claim.at) < windowMs(deps)) continue;
    out.push(await settle(deps, lane, claim.evidence));
  }
  return out;
};
