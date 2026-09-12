import { describe, expect, test } from "bun:test";
import { proxyStillLiveAfterStop, inspectMacosUpdateServiceProvenance, type ServiceDiagnostic, type ServiceInstallState } from "../src/service";

/**
 * #764: `ccx service stop` reported success while the proxy kept running. Routing is now
 * restored before any termination attempt, but the command must still detect the survivor and
 * report that the service itself did not stop.
 *
 * The subtlety is which failure mode matters. PR #780 waited only when `schtasks /end` returned
 * an ERROR -- but the reported case is an /end that SUCCEEDS while the wrapper survives and
 * respawns its child a few seconds later. On that path the stop command has nothing to report,
 * so the outcome has to be probed rather than inferred from the command's exit status.
 */

/** Deterministic clock: no wall-clock sleeping, and the deadline is reached by construction. */
function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
  };
}

describe("service stop verification (#764)", () => {
  test("a clean stop returns immediately when the supervisor cannot respawn", async () => {
    // The regression this must not introduce: launchd and systemd do not bring a child back
    // after unload/stop, so a single probe answers the question. Making every macOS and Linux
    // user wait out a Windows-specific restart window would trade one bug for a worse daily one.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => { probes += 1; return null; },
      canRespawn: false,
      ...clock,
    });
    expect(live).toBeNull();
    expect(probes).toBe(1);
    expect(clock.now()).toBe(0); // no sleeping at all
  });

  test("a proxy that respawns inside the restart window is detected", async () => {
    // The reported failure: /end succeeded, the wrapper lived, and the child came back at ~5s.
    // A single probe immediately after the stop command would have seen nothing and passed.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => {
        probes += 1;
        return probes >= 5 ? { port: 10100 } : null;
      },
      canRespawn: true,
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
    expect(probes).toBeGreaterThan(1);
  });

  test("a genuinely stopped proxy returns null within the bound", async () => {
    // The control. Without it the check could report a survivor every time and block every
    // legitimate stop -- worse than the original false-success bug.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => { probes += 1; return null; },
      canRespawn: true,
      ...clock,
    });
    expect(live).toBeNull();
    expect(probes).toBeGreaterThan(1);
  });

  test("a probe that throws does not count as proof the proxy is gone", async () => {
    // A failing health probe means "unknown", not "stopped". Treating an exception as absence
    // would restore native Codex on top of a proxy that is merely unreachable for a moment.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => {
        probes += 1;
        if (probes < 4) throw new Error("connection refused");
        return { port: 10100 };
      },
      canRespawn: true,
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
  });

  test("an immediately live proxy is caught on the first probe", async () => {
    const clock = fakeClock();
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => ({ port: 10100 }),
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
  });

  test("the platform default drives the behavior, not just the explicit flag", async () => {
    // Every other test passes canRespawn explicitly, so none of them exercises the DEFAULT --
    // a regression to `?? false` would leave them all green while Windows silently lost the
    // restart window it needs. These pin the derivation itself.
    const original = process.platform;
    const setPlatform = (value: string) =>
      Object.defineProperty(process, "platform", { value, configurable: true });
    try {
      setPlatform("linux");
      const linuxClock = fakeClock();
      let linuxProbes = 0;
      await proxyStillLiveAfterStop({
        findProxy: async () => { linuxProbes += 1; return null; },
        ...linuxClock,
      });
      expect(linuxProbes).toBe(1);
      expect(linuxClock.now()).toBe(0);

      setPlatform("win32");
      const winClock = fakeClock();
      let winProbes = 0;
      await proxyStillLiveAfterStop({
        findProxy: async () => { winProbes += 1; return null; },
        ...winClock,
      });
      expect(winProbes).toBeGreaterThan(1);
      expect(winClock.now()).toBeGreaterThanOrEqual(7000);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});


// The injected launchd evidence deliberately uses macOS bundle and realpath syntax.
describe.skipIf(process.platform === "win32")("macOS update supervisor provenance", () => {
  const diagnostic: ServiceDiagnostic = {supported:true,registrationState:"present",supervisorState:"active",installed:true,enabled:true,running:true,viable:true,startable:true,stale:false,conflict:false,backend:"launchd",summary:""};
  const state: ServiceInstallState = {version:3,codexHome:"/isolated/codex",codexCommanderHome:"/isolated/ccx",bunPath:"/Applications/Test.app/Contents/Resources/runtime/bun",cliPath:"/Applications/Test.app/Contents/Resources/runtime/src/cli/index.ts",backend:"scheduler"};
  const inspect = (selected: ServiceInstallState, matches = true) => inspectMacosUpdateServiceProvenance("/Applications/Test.app",{diagnose:()=>diagnostic,evidence:()=>[{kind:"valid",path:"/isolated/state",state:selected}],realpath:((path: string)=>path) as typeof import("node:fs").realpathSync,registrationMatches:()=>matches});
  test("independent CLI service is identified without stopping or migrating it", () => {
    expect(inspect({...state,bunPath:"/opt/bun",cliPath:"/opt/ccx/src/cli/index.ts"}).kind).toBe("independent");
    expect(inspect(state).kind).toBe("bundle");
  });
  test("mixed bundle dependency and changed supervisor registration block replacement", () => {
    expect(()=>inspect({...state,bunPath:"/opt/bun"})).toThrow("mixed");
    expect(()=>inspect(state,false)).toThrow("registration");
  });
});
