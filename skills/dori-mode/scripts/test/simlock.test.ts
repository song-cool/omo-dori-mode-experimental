import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { releaseTicket, takeTicket, waitTurn } from "../src/simlock.ts";
import { fakeClock, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("simlock serves tickets in arrival order, prints the wait position, and drops a ticket whose owner died", async () => {
  const dir = join(state.dir, "simlock");
  const clock = fakeClock(1_000);
  const alive = new Set([11, 22, 33]);
  const logs: string[] = [];
  const deps = (pid: number) => ({ dir, clock, pid, alive: (p: number) => alive.has(p), log: (l: string) => logs.push(`${pid}: ${l}`) });
  const first = takeTicket(deps(11), "xcodebuild test app-a");
  clock.at += 1;
  const second = takeTicket(deps(22), "xcodebuild test app-b");
  clock.at += 1;
  const third = takeTicket(deps(33), "xcodebuild build app-c");
  await waitTurn(deps(11), first);
  // the third waiter polls: it sees position 3, then the first owner dies (its ticket is stale), then the second releases
  let polls = 0;
  const thirdDeps = { ...deps(33), clock: { now: clock.now, sleep: async () => {
    polls++;
    if (polls === 1) alive.delete(11);
    if (polls === 2) releaseTicket(second);
  } } };
  await waitTurn(thirdDeps, third);
  expect(logs).toEqual([
    "11: SIMLOCK acquired 000000000001000-11",
    "33: SIMLOCK waiting: position 3 of 3 (running: pid 11 xcodebuild test app-a)",
    "33: SIMLOCK removed stale ticket 000000000001000-11 (pid 11 xcodebuild test app-a is gone)",
    "33: SIMLOCK waiting: position 2 of 2 (running: pid 22 xcodebuild test app-b)",
    "33: SIMLOCK acquired 000000000001002-33",
  ]);
  expect(existsSync(first)).toBe(false);
  releaseTicket(third);
  expect(readdirSync(dir)).toEqual([]);
});
