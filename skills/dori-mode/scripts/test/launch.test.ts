import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchLane } from "../src/launch.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

// Each herdr pane list answers with the next agent status; the last one sticks.
const launch = async (statuses: string[], screen: string, key = "new-lane") => {
  world.screen = screen;
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv.join(" ").startsWith("herdr tab create")) return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w2:p5" }, tab_id: "w2:t5" } }), err: "" };
    if (argv.join(" ") === "herdr pane list") {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "w2:p5", workspace_id: "w2", agent: "pi", agent_status: status }] } }), err: "" };
    }
    return base(argv, opts);
  };
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# do the thing\n");
  return { r: await launchLane({ ...depsFor(world, fakeClock(T0), state.dir), run }, { key, title: "new", brief, done: "merged acme/app#1" }), brief };
};

test("a lane that herdr still reports idle 60 s after launch is sent 'Read your brief at <path>' once, and the launch says so", async () => {
  const { r, brief } = await launch(["idle", "idle"], "\u276f ");
  expect(r.startup).toBe("STARTUP_OK new-lane w2:p5");
  expect(r.nudge).toStartWith("BRIEF_NUDGED new-lane w2:p5: still idle 60 s after start");
  expect(sent(world)).toEqual([`Read your brief at ${brief}`]);
});

test("a lane that is working at either read is not nudged, whatever its screen shows", async () => {
  const idleLooking = "\u276f \n$0.000 \u2022 0/1M (0.0%)";
  expect((await launch(["idle", "working"], idleLooking)).r.nudge).toBeUndefined();
  expect((await launch(["working"], idleLooking, "busy-lane")).r.nudge).toBeUndefined();
  expect(sent(world)).toEqual([]);
});

test("the lane footer tells the lane to run simulator commands through dori simlock", async () => {
  const { brief } = await launch(["working"], "\u276f ");
  expect(readFileSync(brief, "utf8")).toContain("dori simlock -- <command ...>");
});
