import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HostConfig } from "../src/config.ts";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { closeLane, watchTick } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { checkHost, remoteRunner, remoteScript, SSH_OPTIONS } from "../src/remote.ts";
import { run as realRun, type Ran, type Runner } from "../src/run.ts";
import { checkSignal } from "../src/signals.ts";
import { syncRegistry } from "../src/sync.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const HOST: HostConfig = { ssh: "ana@book", herdr: "/opt/herdr", herdrSession: "dori-lanes", laneWorkspace: "lanes", defaultCwd: "/home/ana/code", briefsDir: "/home/ana/.dori/briefs", sessionsDir: "/home/ana/.omo/agent/sessions", agentCommand: ["omo-interactive", "{model}", "{prompt}"] };

type Remote = { calls: { argv: string[]; cwd?: string; input?: string }[]; screen: string; claim: string; reachable: boolean; commandOut: string; panes: { pane_id: string; workspace_id: string; cwd?: string; agent?: string; agent_status?: string }[]; files: Set<string> };

const newRemote = (): Remote => ({ calls: [], screen: "❯ ", claim: "", reachable: true, commandOut: " 12 pass\n 0 fail", panes: [{ pane_id: "w1:p2", workspace_id: "w1", cwd: "/home/ana/code", agent: "omo", agent_status: "idle" }], files: new Set() });

const remoteFake = (r: Remote): Runner => async (argv, opts = {}) => {
  r.calls.push({ argv: [...argv], ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.input !== undefined ? { input: opts.input } : {}) });
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  if (!r.reachable) return { code: 255, out: "", err: "ssh: connect to host book port 22: Operation timed out" };
  const line = argv.join(" ");
  if (argv[0] === "/opt/herdr" && argv[1] === "--version") return ok("herdr 0.9.3");
  if (line === "herdr workspace list") return ok(JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "lanes" }] } }));
  if (line.startsWith("herdr tab create")) return ok(JSON.stringify({ result: { root_pane: { pane_id: "w1:p2" }, tab_id: "w1:t2" } }));
  if (line === "herdr pane list") return ok(JSON.stringify({ result: { panes: r.panes } }));
  if (line.startsWith("herdr pane read")) return ok(r.screen);
  if (line.startsWith("herdr pane process-info")) return ok(JSON.stringify({ result: { process_info: { shell_pid: 0 } } }));
  if (argv[0] === "herdr") return ok();
  if (argv[0] === "cat" && argv[1]?.endsWith(".done")) return r.claim ? ok(r.claim) : { code: 1, out: "", err: "No such file" };
  if (argv[0] === "rm") {
    r.claim = "";
    return ok();
  }
  if (argv[0] === "sh" && argv[2]?.includes("test -e")) return r.files.has(argv[4] ?? "") ? ok(`/home/ana/code/${argv[4]}`) : { code: 1, out: "", err: "" };
  if (argv[0] === "bun") return ok(r.commandOut);
  if (argv[0] === "git" && argv.includes("worktree") && argv.includes("list")) return ok("worktree /home/ana/code\nbranch refs/heads/main");
  if (argv[0] === "ps") return ok("");
  return ok();
};

let state: ReturnType<typeof withState>;
let world: World;
let remote: Remote;
const at = (ms: number) => ({ ...depsFor(world, fakeClock(ms), state.dir, { hosts: { book: HOST } }), hostRunner: (name: string) => (name === "book" ? remoteFake(remote) : (() => { throw new Error(`unexpected host ${name}`); })()) });
const localHerdr = () => world.calls.filter((c) => c[0] === "herdr");
const lane: Lane = { key: "far-lane", title: "far", thread: "none", host: "book", claimFile: "/home/ana/.dori/briefs/far-lane.done", pane: "w1:p2", tab: "w1:t2", brief: "/home/ana/.dori/briefs/far-lane.md", done: 'command ["bun","test"] stdout~" 0 fail"; file qa/report.json; merged acme/app#1', cwd: "/home/ana/code", openedAt: new Date(T0 - 60 * MIN).toISOString() };

beforeEach(() => {
  state = withState();
  world = newWorld();
  remote = newRemote();
});
afterEach(() => state.done());

test("the remote script keeps every argument intact through a real shell, maps herdr to the host's binary and session, and cds first", async () => {
  const nasty = ["it's", 'say "hi"; rm -rf /', "$(whoami)", "`id`", "a b\tc", "~/x", "*"];
  for (const shell of ["sh", "zsh"]) {
    const r = await realRun([shell, "-c", remoteScript({ ssh: "x" }, ["printf", "%s\\n", ...nasty], "/tmp")]);
    expect(r.out.split("\n")).toEqual(nasty);
  }
  const pwd = await realRun(["sh", "-c", remoteScript({ ssh: "x" }, ["pwd"], state.dir)]);
  expect(pwd.out.endsWith(state.dir.split("/").pop() ?? "?")).toBe(true);
  const mapped = await realRun(["sh", "-c", remoteScript({ ssh: "x", herdr: "echo", herdrSession: "dori-lanes" }, ["herdr", "pane", "list"])]);
  expect(mapped.out).toBe("--session dori-lanes pane list");
  expect(() => remoteScript({ ssh: "x", path: ["/ok", "/bad;rm"] }, ["true"])).toThrow("host path entry");
});

test("the remote runner calls ssh in batch mode with one script argument, passes stdin through and always sets a timeout", async () => {
  const seen: { argv: readonly string[]; opts?: object }[] = [];
  const spy: Runner = async (argv, opts) => {
    seen.push({ argv, opts });
    return { code: 0, out: "", err: "" };
  };
  await remoteRunner(spy, HOST)(["cat"], { input: "brief text" });
  expect(seen[0]?.argv.slice(0, -1)).toEqual(["ssh", ...SSH_OPTIONS, "ana@book"]);
  expect(seen[0]?.argv).toHaveLength(SSH_OPTIONS.length + 3);
  expect(seen[0]?.opts).toEqual({ timeoutMs: 60_000, input: "brief text" });
});

test("hosts check reports an unreachable host as HOST_DOWN with the ssh reason and a reachable one as HOST_OK with its herdr server state", async () => {
  remote.reachable = false;
  const down = await checkHost(at(T0), "book");
  expect(down.ok).toBe(false);
  expect(down.line).toStartWith("HOST_DOWN book ssh ana@book: ssh: connect to host book");
  remote.reachable = true;
  const up = await checkHost(at(T0), "book");
  expect(up.line).toBe("HOST_OK book herdr 0.9.3 server=up");
});

test("launch --host writes the brief with a remote footer on the host, opens the tab there and records the host; local herdr is never used", async () => {
  const brief = join(state.dir, "far.md");
  writeFileSync(brief, "ulw set goal and work\n\n# Far lane\n");
  const r = await launchLane(at(T0), { key: "far-lane", title: "far", brief, done: 'command ["bun","test"] stdout~" 0 fail"', host: "book" });
  expect(r.startup).toBe("STARTUP_OK far-lane w1:p2 on book");
  expect(r.lane).toMatchObject({ host: "book", pane: "w1:p2", tab: "w1:t2", cwd: "/home/ana/code", brief: "/home/ana/.dori/briefs/far-lane.md", claimFile: "/home/ana/.dori/briefs/far-lane.done" });
  const write = remote.calls.find((c) => c.input !== undefined);
  expect(write?.argv.slice(-3)).toEqual(["/home/ana/.dori/briefs", "/home/ana/.dori/briefs/far-lane.md", "/home/ana/.dori/briefs/far-lane.done"]);
  expect(write?.input).toContain("printf '%s\\n' \"<merge SHA, closed issue, version>\" > /home/ana/.dori/briefs/far-lane.done");
  expect(write?.input).not.toContain("dori claim-done");
  expect(remote.calls.some((c) => c.argv.join(" ") === "herdr tab create --workspace w1 --cwd /home/ana/code --label far-lane --no-focus")).toBe(true);
  const started = remote.calls.find((c) => c.argv[1] === "pane" && c.argv[2] === "run");
  expect(started?.argv[4]).toStartWith("omo-interactive anthropic/claude-opus-5-5 'ulw set goal and work. Read and execute the lane brief at /home/ana/.dori/briefs/far-lane.md");
  expect(localHerdr()).toEqual([]);
  expect((await at(T0).registry.read("far-lane"))?.host).toBe("book");
});

test("launch --host refuses before touching anything when the host is unreachable", async () => {
  remote.reachable = false;
  const brief = join(state.dir, "far.md");
  writeFileSync(brief, "brief\n");
  await expect(launchLane(at(T0), { key: "far-lane", title: "far", brief, done: 'command ["true"]', host: "book" })).rejects.toThrow("host book unreachable");
  expect(await at(T0).registry.read("far-lane")).toBeNull();
});

test("a claim the remote lane writes to its claim file is pulled by watch, removed on the host, and acknowledged in the remote pane", async () => {
  await at(T0).registry.write(lane);
  expect(await watchTick(at(T0))).toEqual([]);
  remote.claim = "tests green, report at qa/report.json\n";
  const lines = await watchTick(at(T0 + MIN));
  expect(lines).toEqual(["LANE_DONE_CLAIMED far-lane w1:p2 tests green, report at qa/report.json"]);
  const after = await at(T0).registry.read("far-lane");
  expect(after && statusOf(after)).toBe("done-claimed");
  expect(remote.calls.some((c) => c.argv[0] === "rm" && c.argv[2] === lane.claimFile)).toBe(true);
  expect(remote.calls.some((c) => c.argv[2] === "send-text" && c.argv[4]?.startsWith("[LEAD] done claim recorded for far-lane"))).toBe(true);
  expect(localHerdr()).toEqual([]);
});

test("closing a remote lane runs command and file signals on the host in the lane's cwd, keeps gh local, and closes the tab on the host", async () => {
  remote.files.add("qa/report.json");
  const r = await closeLane(at(T0), lane, "done");
  expect(r.closed).toBe(true);
  expect(remote.calls.find((c) => c.argv[0] === "bun")).toMatchObject({ argv: ["bun", "test"], cwd: "/home/ana/code" });
  expect(remote.calls.some((c) => c.argv[0] === "sh" && c.argv[4] === "qa/report.json" && c.cwd === "/home/ana/code")).toBe(true);
  expect(world.calls.some((c) => c[0] === "gh")).toBe(true);
  expect(remote.calls.some((c) => c.argv[0] === "gh")).toBe(false);
  expect(remote.calls.some((c) => c.argv.join(" ") === "herdr tab close w1:t2")).toBe(true);
  expect(localHerdr()).toEqual([]);
});

test("a remote signal that does not read back live refuses the close, and the tab stays open", async () => {
  remote.commandOut = " 11 pass\n 1 fail";
  const r = await closeLane(at(T0), lane, "done");
  expect(r.closed).toBe(false);
  expect(r.lines).toContain('SIGNAL NOT file qa/report.json -> missing on host: qa/report.json');
  expect(remote.calls.some((c) => c.argv[2] === "close")).toBe(false);
});

test("unpushed commits in a remote worktree are found with git on the host and block the settle", async () => {
  await at(T0).registry.write({ ...lane, done: 'command ["bun","test"]', worktrees: ["/home/ana/code/.wt/far-lane"], status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "x", emitted: true } });
  const base = remoteFake(remote);
  const deps = { ...at(T0 + 6 * MIN), hostRunner: () => (async (argv: readonly string[], opts?: object) => (argv[0] === "git" && argv.includes("rev-list") ? { code: 0, out: "3", err: "" } : base(argv, opts))) as Runner };
  await watchTick(deps);
  const after = await deps.registry.read("far-lane");
  expect(after?.objection?.reasons).toEqual(["unpushed work in /home/ana/code/.wt/far-lane"]);
  expect(remote.calls.some((c) => c.argv[0] === "test" && c.argv[2] === "/home/ana/code/.wt/far-lane")).toBe(true);
});

test("sync shows a remote lane with its host, and an unreachable host as drift instead of a crash", async () => {
  await at(T0).registry.write(lane);
  const ok = await syncRegistry(at(T0), false);
  expect(ok.rows.map((r) => r.pane)).toEqual(["book/w1:p2"]);
  expect(ok.drift).toEqual([]);
  remote.panes = [];
  expect((await syncRegistry(at(T0), false)).drift).toEqual(["far-lane: pane book/w1:p2 is gone but the lane is working"]);
  remote.reachable = false;
  expect((await syncRegistry(at(T0), false)).drift[0]).toStartWith("far-lane: host book not readable");
});

test("a stopped agent in a remote lane's pane is reported with its host after two agreeing reads, and other panes on that host are never read", async () => {
  remote.screen = "omo has stopped\n$ ";
  remote.panes = [{ pane_id: "w1:p2", workspace_id: "w1" }, { pane_id: "w1:p9", workspace_id: "w1" }];
  const deps = at(T0);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st, { lanes: [lane], runnerOn: () => remoteFake(remote) });
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual(["DEAD_PANE book/w1:p2"]);
  expect(remote.calls.every((c) => ["herdr pane list", "herdr pane read w1:p2 --source recent --lines 6"].includes(c.argv.join(" ")))).toBe(true);
});

test("a remote lane pane its host's herdr reports alive is never dead, and an unreachable host is skipped, not reported", async () => {
  remote.screen = "omo has stopped\n$ ";
  remote.panes = [{ pane_id: "w1:p2", workspace_id: "w1", agent: "omo", agent_status: "working" }];
  const deps = at(T0);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st, { lanes: [lane], runnerOn: () => remoteFake(remote) });
  expect([...(await tick()), ...(await tick())]).toEqual([]);
  remote.reachable = false;
  expect([...(await tick()), ...(await tick()), ...(await tick())]).toEqual([]);
});

test("the remote file check resolves relative paths from the lane cwd and checks sha256 and JSON through a real shell", async () => {
  writeFileSync(join(state.dir, "report.json"), JSON.stringify({ passed: true }));
  const sha = new Bun.CryptoHasher("sha256").update(JSON.stringify({ passed: true })).digest("hex");
  const io = { cwd: state.dir, exec: realRun };
  expect((await checkSignal(`file report.json sha256=${sha} json:.passed=true`, realRun, io)).ok).toBe(true);
  expect((await checkSignal("file report.json json:.passed=false", realRun, io)).detail).toBe(".passed is true, want false");
  expect((await checkSignal("file nope.json", realRun, io)).detail).toBe("missing on host: nope.json");
});
