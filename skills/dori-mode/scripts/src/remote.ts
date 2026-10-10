import type { DoriConfig, GuardThresholds, HostConfig } from "./config.ts";
import type { Lane } from "./registry.ts";
import type { Clock, Runner } from "./run.ts";

export class HostError extends Error {}

export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"] as const;
export const REMOTE_TIMEOUT_MS = 60_000;
// Non-interactive SSH gets a minimal PATH, so the usual user tool dirs are added in front of it.
export const DEFAULT_REMOTE_PATH = ["$HOME/.local/bin", "$HOME/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"] as const;

export const shq = (arg: string): string => (/^[\w./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

export const herdrArgv = (host: HostConfig): string[] => [host.herdr ?? "herdr", ...(host.herdrSession ? ["--session", host.herdrSession] : [])];

export const remoteScript = (host: HostConfig, argv: readonly string[], cwd?: string): string => {
  const dirs = host.path ?? DEFAULT_REMOTE_PATH;
  const bad = dirs.find((d) => !/^[\w./$-]+$/.test(d));
  if (bad) throw new HostError(`host path entry ${JSON.stringify(bad)} may only use letters, digits, . / - _ and $HOME`);
  const full = argv[0] === "herdr" ? [...herdrArgv(host), ...argv.slice(1)] : [...argv];
  return `export PATH="${[...dirs, "$PATH"].join(":")}"; ${cwd ? `cd ${shq(cwd)} && ` : ""}exec ${full.map(shq).join(" ")}`;
};

export const remoteRunner = (run: Runner, host: HostConfig): Runner => async (argv, opts = {}) =>
  run(["ssh", ...SSH_OPTIONS, host.ssh, remoteScript(host, argv, opts.cwd)], { timeoutMs: opts.timeoutMs ?? REMOTE_TIMEOUT_MS, ...(opts.input !== undefined ? { input: opts.input } : {}) });

export const hostOf = (config: DoriConfig, name: string): HostConfig => {
  const host = config.hosts[name];
  if (!host?.ssh) throw new HostError(`no host "${name}" in config.hosts (known: ${Object.keys(config.hosts).join(", ") || "none"})`);
  return host;
};

export type HostDeps = { readonly run: Runner; readonly config: DoriConfig; readonly hostRunner?: (name: string) => Runner };

export const runnerOnHost = (deps: HostDeps, name: string): Runner => deps.hostRunner?.(name) ?? remoteRunner(deps.run, hostOf(deps.config, name));

export const runnerFor = (deps: HostDeps, lane: Pick<Lane, "host">): Runner => (lane.host ? runnerOnHost(deps, lane.host) : deps.run);

export const hostGuard = (config: DoriConfig, name: string): GuardThresholds => ({ ...config.guard, ...hostOf(config, name).guard });

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";

export type HostStatus = { readonly name: string; readonly ok: boolean; readonly line: string; readonly server: boolean };

const serverUp = (out: string): boolean => {
  try {
    return Array.isArray((JSON.parse(out) as { result?: { workspaces?: unknown } }).result?.workspaces);
  } catch {
    return false;
  }
};

export const checkHost = async (deps: HostDeps, name: string): Promise<HostStatus> => {
  const host = hostOf(deps.config, name);
  const remote = runnerOnHost(deps, name);
  const v = await remote([host.herdr ?? "herdr", "--version"], { timeoutMs: 20_000 });
  if (v.code === 255 || v.code === 124) return { name, ok: false, server: false, line: `HOST_DOWN ${name} ssh ${host.ssh}: ${firstLine(v.err) || `exit ${v.code}`}` };
  if (v.code !== 0) return { name, ok: false, server: false, line: `HOST_DOWN ${name} herdr not runnable: ${firstLine(v.err || v.out) || `exit ${v.code}`}` };
  const ws = await remote(["herdr", "workspace", "list"], { timeoutMs: 20_000 });
  const server = ws.code === 0 && serverUp(ws.out);
  return { name, ok: true, server, line: `HOST_OK ${name} ${firstLine(v.out)} server=${server ? "up" : "down (dori launch starts it)"}` };
};

type Workspace = { readonly workspace_id: string; readonly label?: string };

const workspaces = async (remote: Runner): Promise<Workspace[] | null> => {
  const r = await remote(["herdr", "workspace", "list"]);
  if (r.code !== 0 || !serverUp(r.out)) return null;
  return (JSON.parse(r.out) as { result: { workspaces: Workspace[] } }).result.workspaces;
};

// Starts the host's headless herdr server (its own named session when herdrSession is set) if it is not running.
export const ensureServer = async (remote: Runner, host: HostConfig, clock: Clock): Promise<Workspace[]> => {
  const now = await workspaces(remote);
  if (now) return now;
  const start = await remote(["sh", "-c", 'nohup "$@" server </dev/null >/dev/null 2>&1 &', "sh", ...herdrArgv(host)]);
  if (start.code !== 0) throw new HostError(`could not start herdr on ${host.ssh}: ${firstLine(start.err || start.out) || `exit ${start.code}`}`);
  for (let i = 0; i < 15; i++) {
    await clock.sleep(1000);
    const up = await workspaces(remote);
    if (up) return up;
  }
  throw new HostError(`herdr server on ${host.ssh} did not come up within 15 s`);
};

export const laneWorkspaceOn = async (remote: Runner, host: HostConfig, clock: Clock, cwd: string): Promise<string | undefined> => {
  const want = host.laneWorkspace;
  const list = await ensureServer(remote, host, clock);
  if (!want) return list[0]?.workspace_id;
  const hit = list.find((w) => w.workspace_id === want || w.label === want);
  if (hit) return hit.workspace_id;
  const made = await remote(["herdr", "workspace", "create", "--label", want, "--cwd", cwd, "--no-focus"]);
  if (made.code !== 0) throw new HostError(`herdr workspace create failed on ${host.ssh}: ${firstLine(made.err || made.out)}`);
  const again = (await workspaces(remote))?.find((w) => w.label === want);
  if (!again) throw new HostError(`workspace ${want} not found on ${host.ssh} after creating it`);
  return again.workspace_id;
};

export const remotePathExists = async (remote: Runner, path: string): Promise<boolean> => (await remote(["test", "-e", path])).code === 0;
