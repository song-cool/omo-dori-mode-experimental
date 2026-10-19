import { afterEach, beforeEach, expect, test } from "bun:test";

import { closeLane } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const WTROOT = "/srv/work/wt";
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0).toISOString(), simsAtLaunch: ["SIM-A"] };
const other: Lane = { key: "demo-lane-two", title: "two", thread: "none", pane: "w:p2", brief: "/b2.md", done: "merged acme/app#2", cwd: `${WTROOT}/demo-lane-two`, openedAt: new Date(T0).toISOString() };

type P = { pid: number; ppid: number; cmd: string; cwd: string; port?: string };
const machine = (): P[] => [
  { pid: 100, ppid: 1, cmd: "-zsh", cwd: "/repo" },
  { pid: 101, ppid: 100, cmd: "claude lead", cwd: "/repo" },
  { pid: 102, ppid: 101, cmd: "node /repo/node_modules/.bin/next dev", cwd: "/repo", port: "*:3001" },
  { pid: 200, ppid: 1, cmd: "-zsh", cwd: "/repo" },
  { pid: 201, ppid: 200, cmd: "omo --model m", cwd: "/repo" },
  { pid: 203, ppid: 201, cmd: "node /tmp/x/node_modules/.bin/vite", cwd: "/tmp/x", port: "127.0.0.1:5173" },
  { pid: 202, ppid: 1, cmd: "next-server (v15.1.0)", cwd: `${WTROOT}/demo-lane/app`, port: "*:3000" },
  { pid: 300, ppid: 1, cmd: "-zsh", cwd: `${WTROOT}/demo-lane-two` },
  { pid: 301, ppid: 300, cmd: "pnpm dev", cwd: `${WTROOT}/demo-lane-two`, port: "*:5174" },
  { pid: 400, ppid: 1, cmd: "bun /opt/tools/lane-watchdog.ts", cwd: `${WTROOT}/demo-lane` },
  { pid: 500, ppid: 1, cmd: "node server.js", cwd: "/repo" },
  { pid: 900, ppid: 1, cmd: "dori close demo-lane", cwd: "/repo" },
];

// A small process table that reacts to herdr pane close (the lane shell and agent exit, their children are reparented) and to kill.
const host = (w: World, procs: P[], booted: string[]): Runner => {
  const base = fakeRunner(w);
  const shells: Record<string, number> = { "w:p1": 200, "lead:p1": 100, "w:p2": 300 };
  return async (argv, opts) => {
    const line = argv.join(" ");
    const ok = (out: string) => ({ code: 0, out, err: "" });
    if (line.startsWith("herdr pane close w:p1")) {
      for (const dead of [200, 201]) procs.splice(procs.findIndex((p) => p.pid === dead), 1);
      for (const p of procs) if (p.ppid === 201) p.ppid = 1;
    }
    if (line.startsWith("herdr pane process-info")) {
      const pid = procs.some((p) => p.pid === shells[argv[4] ?? ""]) ? shells[argv[4] ?? ""] : undefined;
      return pid ? ok(JSON.stringify({ result: { process_info: { shell_pid: pid } } })) : { code: 1, out: "", err: "no pane" };
    }
    if (argv[0] === "ps") return ok(procs.map((p) => `${p.pid} ${p.ppid} ${p.cmd}`).join("\n"));
    if (line.startsWith("lsof -nP -w -d cwd")) return ok(procs.map((p) => `p${p.pid}\nn${p.cwd}`).join("\n"));
    if (line.startsWith("lsof -nP -w -iTCP")) return ok(procs.filter((p) => p.port).map((p) => `p${p.pid}\nn${p.port}`).join("\n"));
    if (argv[0] === "kill") {
      w.calls.push([...argv]);
      for (const pid of argv.slice(2).map(Number)) procs.splice(procs.findIndex((p) => p.pid === pid), 1);
      return ok("");
    }
    if (argv[0] === "xcrun" && argv[2] === "list") {
      w.calls.push([...argv]);
      return ok(JSON.stringify({ devices: { "iOS-27-0": booted.map((udid) => ({ udid, state: "Booted" })) } }));
    }
    if (argv[0] === "xcrun") {
      w.calls.push([...argv]);
      return ok("");
    }
    if (argv[0] === "thread-status") {
      w.calls.push([...argv]);
      return ok(w.screen);
    }
    return base(argv, opts);
  };
};

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "lead:p1", workspace_id: "w1", title: "lead", cwd: "/repo" }, { pane_id: "w:p2", workspace_id: "w", cwd: `${WTROOT}/demo-lane-two` }];
});
afterEach(() => state.done());

const depsWith = (procs: P[], booted: string[], hooks = {}) => ({
  ...depsFor(world, fakeClock(T0), state.dir, { worktreeRoots: [WTROOT], leftoverKeep: ["lane-watchdog"], hooks }),
  run: host(world, procs, booted),
  selfPid: 900,
  listDir: (dir: string) => (dir === WTROOT ? ["demo-lane", "demo-lane-two", "unrelated"] : []),
});

test("closing a lane kills what its children left running and logs it, but never the lead, the watchdog or another lane", async () => {
  const procs = machine();
  const deps = depsWith(procs, ["SIM-A", "SIM-B"]);
  await deps.registry.write(lane);
  await deps.registry.write(other);
  const r = await closeLane(deps, lane, "Done: merged");
  expect(r.closed).toBe(true);
  expect(world.calls.filter((c) => c[0] === "kill")).toEqual([["kill", "-TERM", "203", "202"]]);
  expect(procs.map((p) => p.pid)).toEqual([100, 101, 102, 300, 301, 400, 500, 900]);
  const receipt = (await deps.registry.read("demo-lane"))?.receipt as { cleanup: string[] };
  expect(receipt.cleanup).toContain("killed 203 node /tmp/x/node_modules/.bin/vite (listening :5173)");
  expect(receipt.cleanup).toContain("killed 202 next-server (v15.1.0) (listening :3000)");
  // SIM-B was booted after launch, but demo-lane-two is still open, so it stays up
  expect(receipt.cleanup).toContain("simulators kept, other lanes are running: SIM-B");
  expect(world.calls.some((c) => c[0] === "xcrun" && c[2] === "shutdown")).toBe(false);
});

test("the simulators a lane booted are shut down when no other lane is running, and the ones booted before it are left alone", async () => {
  const deps = depsWith(machine().filter((p) => p.pid < 300 || p.pid >= 400), ["SIM-A", "SIM-B"]);
  world.panes = [world.panes[0] ?? { pane_id: "lead:p1", workspace_id: "w1" }];
  await deps.registry.write(lane);
  const r = await closeLane(deps, lane, "Done: merged");
  expect(r.lines.at(-1)).toContain("simulator SIM-B shut down");
  expect(world.calls.filter((c) => c[0] === "xcrun" && c[2] === "shutdown")).toEqual([["xcrun", "simctl", "shutdown", "SIM-B"]]);
});

test("a pane whose processes cannot be read stops the leftover scan instead of guessing", async () => {
  world.panes.push({ pane_id: "w:p9", workspace_id: "w" });
  const deps = depsWith(machine(), []);
  await deps.registry.write(lane);
  const r = await closeLane(deps, lane, "Done: merged");
  expect(r.lines.at(-1)).toContain("leftover scan skipped: could not read the processes of pane w:p9");
  expect(world.calls.some((c) => c[0] === "kill")).toBe(false);
});

test("on close the thread status hook is run with status done, and a hook that declines with KEPT is reported as kept", async () => {
  const hooks = { threadStatus: ["thread-status", "{thread}", "{status}"] };
  const deps = depsWith(machine(), [], hooks);
  await deps.registry.write(lane);
  world.screen = "KEPT waiting for an owner decision";
  await closeLane(deps, lane, "Done: merged");
  expect(world.calls).toContainEqual(["thread-status", "chat:team/123", "done"]);
  expect(((await deps.registry.read("demo-lane"))?.receipt as { cleanup: string[] }).cleanup).toContain("thread status kept: waiting for an owner decision");
  await deps.registry.write(lane);
  world.screen = "SET chat:team/123 done";
  await closeLane(deps, lane, "Done: merged");
  expect(((await deps.registry.read("demo-lane"))?.receipt as { cleanup: string[] }).cleanup).toContain("thread status: SET chat:team/123 done");
});
