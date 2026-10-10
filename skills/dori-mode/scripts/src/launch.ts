import { type ArgvTemplate, type DoriConfig, fill, type HostConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen, statusLookup } from "./panes.ts";
import { LANE_KEY, type Lane } from "./registry.ts";
import { hostOf, HostError, laneWorkspaceOn, runnerOnHost } from "./remote.ts";
import { iso, type Runner } from "./run.ts";
import { doneSyntaxErrors } from "./signals.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly host?: string;
  readonly agent?: string;
};

export class LaunchError extends Error {}

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider/i;
const REMOTE_STARTUP_FAILURE = /command not found|no such file or directory/i;

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
};

export const footer = (lane: Lane, leadPane: string): string => [
  "",
  "## Lane footer (written by dori launch)",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  ...(lane.host
    ? [
        `- This lane runs on host ${lane.host}. The lead reads this pane over SSH and cannot be reached from here, so never try to send to the lead's pane or run dori.`,
        `- Report at each milestone by printing one plain line in this pane (in your reply or with echo): [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>.`,
        `- When done: write one line of evidence to ${lane.claimFile}, for example printf '%s\\n' "<merge SHA, closed issue, version>" > ${lane.claimFile}. The lead's watcher records it as your done claim within a minute; an objection arrives here as [LEAD] not done, and you claim again by rewriting the file.`,
      ]
    : [
        `- Report to the lead at each milestone: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>, sent to pane ${leadPane || "(lead pane)"} as an argv array, never a shell string.`,
        `- When done: dori claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
      ]),
  "",
].join("\n");

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
};

export const agentTemplate = (config: DoriConfig, host: HostConfig | undefined, agent: string | undefined): ArgvTemplate => {
  if (!agent) return host?.agentCommand ?? config.agentCommand;
  const table = host ? host.agentCommands : config.agentCommands;
  const t = table?.[agent];
  if (!t) throw new LaunchError(`no agentCommands.${agent} ${host ? "for this host" : "in config"} (have: ${Object.keys(table ?? {}).join(", ") || "none"})`);
  return t;
};

type Placement = { readonly run: Runner; readonly brief: string; readonly claimFile?: string; readonly workspace?: string; readonly cwd: string; readonly model: string; readonly template: ArgvTemplate };

const placeLocally = async (deps: FlowDeps, input: LaunchInput, text: string): Promise<Placement> => {
  await Bun.write(input.brief, text);
  return { run: deps.run, brief: input.brief, workspace: deps.config.laneWorkspace || undefined, cwd: input.cwd ?? deps.config.defaultCwd, model: input.model ?? deps.config.defaultModel, template: agentTemplate(deps.config, undefined, input.agent) };
};

const placeOnHost = async (deps: FlowDeps, input: LaunchInput, name: string, text: string, claimFile: string, remoteBrief: string): Promise<Placement> => {
  const host = hostOf(deps.config, name);
  const run = runnerOnHost(deps, name);
  const cwd = input.cwd ?? host.defaultCwd ?? "";
  if (!cwd) throw new LaunchError(`pass --cwd or set hosts.${name}.defaultCwd`);
  const wrote = await run(["sh", "-c", 'mkdir -p "$1" && rm -f "$3" && cat > "$2"', "sh", host.briefsDir ?? "", remoteBrief, claimFile], { input: text });
  if (wrote.code === 255) throw new LaunchError(`host ${name} unreachable: ${wrote.err.split("\n")[0] ?? ""}`);
  if (wrote.code !== 0) throw new LaunchError(`could not write the brief on ${name}: ${wrote.err || wrote.out}`);
  if ((await run(["test", "-d", cwd])).code !== 0) throw new LaunchError(`cwd ${cwd} does not exist on ${name}`);
  let workspace: string | undefined;
  try {
    workspace = await laneWorkspaceOn(run, host, deps.clock, cwd);
  } catch (e) {
    throw new LaunchError(e instanceof HostError ? e.message : String(e));
  }
  return { run, brief: remoteBrief, claimFile, workspace, cwd, model: input.model ?? host.defaultModel ?? deps.config.defaultModel, template: agentTemplate(deps.config, host, input.agent) };
};

export const launchLane = async (deps: FlowDeps, input: LaunchInput): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  await validateLaunch(deps, input);
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const host = input.host ? hostOf(deps.config, input.host) : undefined;
  if (host && !host.briefsDir) throw new LaunchError(`set hosts.${input.host}.briefsDir (an absolute directory on that host for briefs and done claims)`);
  const remoteBrief = host ? `${host.briefsDir}/${input.key}.md` : input.brief;
  const claimFile = host ? `${host.briefsDir}/${input.key}.done` : undefined;
  const draft: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", brief: remoteBrief, done: input.done, cwd: input.cwd ?? host?.defaultCwd ?? deps.config.defaultCwd, model: input.model, openedAt: iso(deps.clock), ...(input.host ? { host: input.host, claimFile } : {}) };
  const text = `${(await briefFile.text()).replace(/\s*$/, "")}\n${footer(draft, deps.config.leadPane)}`;
  const at = input.host && claimFile ? await placeOnHost(deps, input, input.host, text, claimFile, remoteBrief) : await placeLocally(deps, input, text);
  if (input.host) await Bun.write(input.brief, text);
  const created = await at.run(["herdr", "tab", "create", ...(at.workspace ? ["--workspace", at.workspace] : []), "--cwd", at.cwd, "--label", input.key, "--no-focus"]);
  if (created.code !== 0) throw new LaunchError(`herdr tab create failed${input.host ? ` on ${input.host}` : ""}: ${created.err || created.out}`);
  const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
  const pane = made.root_pane.pane_id;
  const tab = made.tab_id ?? made.root_pane.tab_id;
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${at.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  await at.run(["herdr", "pane", "run", pane, fill(at.template, { model: at.model, prompt }).map(quoteForPane).join(" ")]);
  const lane: Lane = { ...draft, cwd: at.cwd, model: at.model, pane, ...(tab ? { tab } : {}) };
  await deps.registry.write(lane);
  await deps.clock.sleep(20_000);
  const screen = await readScreen(at.run, pane, 40);
  const bad = STARTUP_FAILURE.exec(screen) ?? (input.host ? REMOTE_STARTUP_FAILURE.exec(screen) : null);
  const where = input.host ? ` on ${input.host}` : "";
  if (bad) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}${where}: ${bad[0]}` };
  const { status, error } = await statusLookup(at.run, pane);
  if (status === "idle" || status === "working") return { lane, startup: `STARTUP_OK ${input.key} ${pane}${where}` };
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}${where}: ${why}; last lines: ${lastLines(screen)}` };
};

const lastLines = (screen: string): string =>
  screen.split("\n").map((s) => s.trim()).filter(Boolean).slice(-3).join(" / ").replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)").slice(0, 240) || "(blank)";

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
