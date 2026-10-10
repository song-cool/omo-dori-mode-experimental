import type { FlowDeps } from "./done-flow.ts";
import { listPanes, type Pane } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { hostOf, runnerOnHost } from "./remote.ts";
import type { Runner } from "./run.ts";
import { type Proc, procTable, remoteListDir, resolveSession, type SessionDeps } from "./session-id.ts";

export type SyncRow = { readonly key: string; readonly thread: string; readonly pane: string; readonly session: string; readonly status: string };
export type SyncResult = { readonly rows: SyncRow[]; readonly drift: string[]; readonly unregistered: SyncRow[] };

type Machine = { readonly live: Map<string, Pane> | null; readonly table: readonly Proc[]; readonly session: SessionDeps; readonly error?: string };

const remoteMachine = async (deps: FlowDeps, name: string): Promise<Machine> => {
  const run: Runner = runnerOnHost(deps, name);
  const session: SessionDeps = { run, sessionsDir: hostOf(deps.config, name).sessionsDir ?? "", listDir: remoteListDir(run) };
  try {
    const panes = await listPanes(run);
    return { live: new Map(panes.map((p) => [p.pane_id, p])), table: await procTable(run), session };
  } catch (e) {
    return { live: null, table: [], session, error: (e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 160) };
  }
};

export const syncRegistry = async (deps: FlowDeps, write: boolean): Promise<SyncResult> => {
  const panes = await listPanes(deps.run);
  const local: Machine = { live: new Map(panes.map((p) => [p.pane_id, p])), table: await procTable(deps.run), session: { run: deps.run, sessionsDir: deps.config.sessionsDir } };
  const rows: SyncRow[] = [];
  const drift: string[] = [];
  const lanes = await deps.registry.open();
  const machines = new Map<string, Machine>();
  for (const name of new Set(lanes.flatMap((l) => (l.host ? [l.host] : [])))) machines.set(name, await remoteMachine(deps, name));
  for (const lane of lanes) {
    const m = lane.host ? (machines.get(lane.host) as Machine) : local;
    const where = (l: Lane) => (l.host ? `${l.host}/${l.pane ?? "-"}` : (l.pane ?? "-"));
    if (!m.live) drift.push(`${lane.key}: host ${lane.host} not readable (${m.error}), pane state unknown`);
    const pane = lane.pane ? m.live?.get(lane.pane) : undefined;
    if (m.live && !pane) drift.push(`${lane.key}: pane ${lane.pane ? where(lane) : "(none)"} is gone but the lane is ${statusOf(lane)}`);
    const hit = pane ? await resolveSession(pane.pane_id, pane.cwd ?? "", m.table, m.session) : { id: "", via: "none" };
    if (lane.session && hit.id && hit.id !== lane.session) drift.push(`${lane.key}: pane now runs session ${hit.id} (registry has ${lane.session})`);
    if (!lane.done) drift.push(`${lane.key}: empty Done line, so a done claim can never close it`);
    if (write && hit.id && hit.id !== lane.session) await deps.registry.write({ ...lane, session: hit.id, sessionVia: hit.via });
    rows.push({ key: lane.key, thread: lane.thread, pane: where(lane), session: hit.id ? `${hit.id} (${hit.via})` : (lane.session ?? "-"), status: statusOf(lane) });
  }
  const owned = new Set(lanes.filter((l) => !l.host).map((l) => l.pane));
  const watch = new Set(deps.config.workspaces);
  const skip = new Set([deps.config.leadPane, ...deps.config.ignorePanes]);
  const unregistered: SyncRow[] = [];
  for (const p of panes) {
    if (owned.has(p.pane_id) || skip.has(p.pane_id) || (watch.size > 0 && !watch.has(p.workspace_id))) continue;
    if (p.agent === undefined) continue;
    const hit = await resolveSession(p.pane_id, p.cwd ?? "", local.table, local.session);
    unregistered.push({ key: p.title ?? p.pane_id, thread: "-", pane: p.pane_id, session: hit.id ? `${hit.id} (${hit.via})` : "-", status: "unregistered" });
  }
  return { rows, drift, unregistered };
};
