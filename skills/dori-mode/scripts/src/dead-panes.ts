import type { DoriConfig } from "./config.ts";
import { ALIVE_STATUSES, listPanes, readScreen } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { Runner } from "./run.ts";

/** Unrecognised ticks in a row before one alert names the pane. */
export const UNRECOGNISED_ALERT_AFTER = 3;

/** Per-pane memory across ticks: the CLI keeps one of these for the life of the loop. */
export type DeadPaneState = { readonly unknown: Map<string, number>; readonly lastTail: Map<string, string> };
export const newDeadPaneState = (): DeadPaneState => ({ unknown: new Map(), lastTail: new Map() });

/** On a remote host only the panes of registered lanes are read, never the owner's other panes there. */
export type RemoteLanes = { readonly lanes: readonly Lane[]; readonly runnerOn: (host: string) => Runner };

/**
 * A pane is alive when herdr reports a running agent status for it; that wins over any screen text. Otherwise it is
 * dead only when this tick's tail carries a configured dead marker AND equals the previous tick's tail, so the two
 * reads are a full loop interval apart and a screen mid-redraw never counts. A marker seen once is pending. Anything
 * else is unrecognised, counted per pane, with one alert after UNRECOGNISED_ALERT_AFTER ticks in a row.
 * Remote lane panes follow the same rules with their host's herdr, and print as `<host>/<pane>`.
 */
export const deadPaneTick = async (run: Runner, config: DoriConfig, seen: Set<string>, hourKey: string, state: DeadPaneState = newDeadPaneState(), remote?: RemoteLanes): Promise<string[]> => {
  const out: string[] = [];
  const marked = (tail: string) => config.deadPanePatterns.some((p) => tail.includes(p.toLowerCase()));
  const judge = async (id: string, status: string | undefined, readTail: () => Promise<string>): Promise<void> => {
    if (status && ALIVE_STATUSES.has(status)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      return;
    }
    const tail = (await readTail()).toLowerCase();
    const previous = state.lastTail.get(id);
    state.lastTail.set(id, tail);
    if (marked(tail)) {
      state.unknown.delete(id);
      if (previous !== tail) return;
      const mark = `${id} ${hourKey}`;
      if (seen.has(mark)) return;
      seen.add(mark);
      out.push(`DEAD_PANE ${id}`);
      return;
    }
    const n = (state.unknown.get(id) ?? 0) + 1;
    state.unknown.set(id, n);
    if (n === UNRECOGNISED_ALERT_AFTER) out.push(`UNRECOGNISED_PANE ${id} dead-panes: no alive status and no dead marker for ${n} ticks`);
  };
  const watch = new Set(config.workspaces);
  const skip = new Set([config.leadPane, ...config.ignorePanes].filter(Boolean));
  for (const pane of await listPanes(run)) {
    if (skip.has(pane.pane_id) || (watch.size > 0 && !watch.has(pane.workspace_id))) continue;
    await judge(pane.pane_id, pane.agent_status, () => readScreen(run, pane.pane_id, 6));
  }
  for (const lane of remote?.lanes ?? []) {
    const pane = lane.pane;
    if (!remote || !lane.host || !pane || statusOf(lane) === "closed") continue;
    const there = remote.runnerOn(lane.host);
    // An unreachable host is not evidence of a dead pane: skip it this tick (hosts check reports the host itself).
    const listed = await listPanes(there).catch(() => null);
    if (!listed) continue;
    await judge(`${lane.host}/${pane}`, listed.find((p) => p.pane_id === pane)?.agent_status, () => readScreen(there, pane, 6));
  }
  return out;
};
