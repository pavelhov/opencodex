import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacosUpdateTransactionStore, prepareMacosUpdate, assertMacosUpdateAllowsMutation, withMacosUpdateRecovery } from "../src/server/macos-update-transaction";
import { acquireProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import { handleMacosUpdateAdmission, inspectMacosRuntimeBundleProvenance } from "../src/server/macos-update-admission";
import { proxyLifecycleLockLeaseHeaders } from "../src/server/proxy-lifecycle-protocol";
import { getDefaultConfig } from "../src/config";
import { acquireTemporaryDrain, getActiveTurnCount, tryAdmitTurn, resetLifecycleDrainStateForTests } from "../src/server/lifecycle";
// These macOS fixtures require POSIX permissions, directory fsync, and bundle paths.
// Keep Linux coverage; Windows cannot represent the durability/provenance contract.
const roots: string[] = [];
afterEach(() => {
  resetLifecycleDrainStateForTests();
  for (const root of roots.splice(0))
    rmSync(root, {
      recursive: true, force: true
    });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ccx-update-"));
  roots.push(root);
  const authority = await acquireProxyLifecycleAuthority({
    includeStart: true, acquireEnsureLock: async () => ({
      token: "ensure", release() { }
    }), acquireStartLock: async () => ({
      token: "start", release() { }
    })
  });
  const store = new MacosUpdateTransactionStore(join(root, "update.json"));
  const snapshot = {
    running: true, routing: "native" as const, supervision: "none" as const, process: null, supervisorFingerprint: null
  };
  const request = {
    transactionId: "test-update", source: {
      bundlePath: "/Applications/Test.app", build: "100"
    }, target: {
      bundlePath: "/Applications/Test.app", build: "101"
    }
  };
  return {
    store, authority, snapshot, request
  };
}
describe.skipIf(process.platform === "win32")("macOS durable update exclusion", () => {
  test("persists before stopping and retains original snapshot across retries and helper exit", async () => {
    const f = await fixture();
    let stopped = 0;
    const io = {
      capture: async () => f.snapshot, fence: async () => ({
        active: 0, release() { }
      }), stop: async () => { expect(f.store.read()?.phase).toBe("preparing"); stopped++; }, verify: async () => true
    };
    expect((await prepareMacosUpdate(f.store, f.authority, f.request, io)).status).toBe("prepared");
    f.authority.releaseAll();
    expect(() => assertMacosUpdateAllowsMutation(f.store)).toThrow("Finish Update");
    expect(f.store.read()?.original.running).toBe(true);
    expect(stopped).toBe(1);
  });
  test("active work immediately needs consent; Later releases admission without interruption", async () => {
    const f = await fixture();
    const turn = tryAdmitTurn()!;
    let stops = 0;
    const io = {
      capture: async () => f.snapshot, fence: async () => { const lease = acquireTemporaryDrain("update")!; return {
        active: getActiveTurnCount(), release: () => lease.release()
      }; }, stop: async () => { stops++; }, verify: async () => true
    };
    expect((await prepareMacosUpdate(f.store, f.authority, f.request, io)).status).toBe("confirmation-required");
    expect(getActiveTurnCount()).toBe(1);
    expect(stops).toBe(0);
    // A confirmation response releases the reversible fence; the retry must re-fence.
    const laterTurn = tryAdmitTurn();
    expect(laterTurn).not.toBeNull();
    laterTurn?.release();
    turn.release();
    expect((await prepareMacosUpdate(f.store, f.authority, {
      ...f.request, updateAnyway: true
    }, io)).status).toBe("prepared");
    expect(stops).toBe(1);
  });
  test("uncertain stop cannot report prepared or lose exclusion", async () => {
    const f = await fixture();
    const result = await prepareMacosUpdate(f.store, f.authority, f.request, {
      capture: async () => f.snapshot, fence: async () => ({
        active: 0, release() { }
      }), stop: async () => { throw Error("timeout"); }, verify: async () => false
    });
    expect(result.status).toBe("blocked");
    expect(f.store.read()?.phase).toBe("uncertain");
  });
  test("conflicting duplicate cannot overwrite snapshot and armed cannot be cancelled by age", async () => {
    const f = await fixture();
    f.store.begin(f.authority, f.request, f.snapshot);
    expect(() => f.store.begin(f.authority, {
      ...f.request, transactionId: "other"
    }, {
      ...f.snapshot, running: false
    })).toThrow();
    f.store.transition(f.authority, f.request.transactionId, "prepared");
    f.store.transition(f.authority, f.request.transactionId, "armed");
    f.store.recordOff(f.authority);
    expect(f.store.read()?.latestIntent?.running).toBe(false);
    expect(() => f.store.cancelBeforeArm(f.authority, f.request.transactionId)).toThrow();
    expect(f.store.read()?.original.running).toBe(true);
  });
  test("malformed and linked state fail closed", async () => {
    const f = await fixture();
    writeFileSync(f.store.path, "{}", { mode: 0o600 });
    expect(() => f.store.read()).toThrow();
    rmSync(f.store.path);
    const target = join(roots.at(-1)!, "target");
    writeFileSync(target, "{}");
    symlinkSync(target, f.store.path);
    expect(() => f.store.read()).toThrow();
  });
});
test.skipIf(process.platform === "win32")("admission seal cannot interrupt work without durable Update Anyway authorization", async () => {
  const f = await fixture();
  f.store.begin(f.authority, f.request, {
    ...f.snapshot, process: {
      pid: process.pid, fingerprint: "fingerprint"
    }
  });
  const headers = {
    ...proxyLifecycleLockLeaseHeaders(f.authority.delegatedLease()!), "x-ccx-update-transaction": f.request.transactionId
  };
  const url = new URL("http://localhost/api/macos-update/admission");
  const io = {
    store: f.store, bundlePath: () => f.request.source.bundlePath, fingerprint: () => "fingerprint", validateLease: () => true
  };
  const call = (method: string) => handleMacosUpdateAdmission(new Request(url, {
    method, headers
  }), url, getDefaultConfig(), io)!;
  const turn = tryAdmitTurn()!;
  const abort = new AbortController();
  turn.bindAbortController(abort);
  expect(call("POST").status).toBe(200);
  expect(tryAdmitTurn()).toBeNull();
  expect(call("PUT").status).toBe(409);
  expect(abort.signal.aborted).toBe(false);
  expect(call("DELETE").status).toBe(200);
  const next = tryAdmitTurn();
  expect(next).not.toBeNull();
  next?.release();
  expect(call("POST").status).toBe(200);
  f.store.authorizeInterruption(f.authority, f.request.transactionId);
  expect(call("PUT").status).toBe(200);
  expect(abort.signal.aborted).toBe(true);
  expect(getActiveTurnCount()).toBe(0);
  expect(tryAdmitTurn()).toBeNull();
});
test.skipIf(process.platform === "win32")("recovery scope is explicit and retry never forgets prior installer arm", async () => {
  const f = await fixture();
  f.store.begin(f.authority, f.request, f.snapshot);
  f.store.transition(f.authority, f.request.transactionId, "prepared");
  f.store.transition(f.authority, f.request.transactionId, "armed");
  f.store.resumeInstallationPreparation(f.authority, f.request.transactionId);
  expect(() => f.store.cancelBeforeArm(f.authority, f.request.transactionId)).toThrow();
  f.store.beginVerifiedRecovery(f.authority, f.request.transactionId, "installer-disarmed");
  expect(() => assertMacosUpdateAllowsMutation(f.store)).toThrow();
  withMacosUpdateRecovery(f.authority, f.request.transactionId, () => expect(() => assertMacosUpdateAllowsMutation(f.store)).not.toThrow(), f.store);
  expect(() => assertMacosUpdateAllowsMutation(f.store)).toThrow();
  f.store.recordNative(f.authority);
  expect(f.store.read()?.latestIntent?.running).toBeNull();
  expect(f.store.read()?.original.running).toBe(true);
});
test.skipIf(process.platform === "win32")("shared mutations remain excluded after helper exit", async () => {
  const f = await fixture();
  f.store.begin(f.authority, f.request, f.snapshot);
  f.authority.releaseAll();
  expect(() => assertMacosUpdateAllowsMutation(f.store)).toThrow("Finish Update");
  expect(f.store.read()?.phase).toBe("preparing");
});

test.skipIf(process.platform === "win32")("seal success followed by failed stop preserves durable recovery and closed admission", async () => {
  const f = await fixture();
  const result = await prepareMacosUpdate(f.store, f.authority, f.request, {
    capture: async () => ({
      ...f.snapshot, process: {
        pid: process.pid, fingerprint: "fingerprint"
      }
    }),
    fence: async (transaction) => {
      const headers = {
        ...proxyLifecycleLockLeaseHeaders(f.authority.delegatedLease()!), "x-ccx-update-transaction": transaction.transactionId
      };
      const url = new URL("http://localhost/api/macos-update/admission");
      const call = (method: string) => handleMacosUpdateAdmission(new Request(url, {
        method, headers
      }), url, getDefaultConfig(), {
        store: f.store, bundlePath: () => f.request.source.bundlePath, fingerprint: () => "fingerprint", validateLease: () => true
      })!;
      expect(call("POST").status).toBe(200);
      expect(call("PUT").status).toBe(200);
      return {
        active: 0, release: () => { call("DELETE"); }
      };
    },
    stop: async () => { throw new Error("bounded stop failed"); },
    verify: async () => false,
  });
  expect(result.status).toBe("blocked");
  expect(f.store.read()?.phase).toBe("uncertain");
  expect(tryAdmitTurn()).toBeNull();
  expect(() => assertMacosUpdateAllowsMutation(f.store)).toThrow();
});

test.skipIf(process.platform === "win32")("a runtime with only one executable dependency inside the bundle is never independent", async () => {
  await fixture();
  const root = roots.at(-1)!;
  const resources = join(root, "Test.app", "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  const module = join(resources, "module.ts");
  const external = join(root, "bun");
  writeFileSync(module, ""); writeFileSync(external, "");
  expect(inspectMacosRuntimeBundleProvenance(module, external).kind).toBe("mixed");
  expect(inspectMacosRuntimeBundleProvenance(external, module).kind).toBe("mixed");
  expect(inspectMacosRuntimeBundleProvenance(external, external).kind).toBe("independent");
});

test.skipIf(process.platform === "win32")("pre-stop supersession is durable and does not mistake partial stop writes for newer intent",async()=>{
  for(const changed of [false,true]) for(const retryEdit of [false,true]) {
    const f=await fixture();let fingerprint=changed?"user-edit":"original";let attempts=0;
    const io={
      capture:async()=>({...f.snapshot,routing:"owned" as const,intentFingerprint:"original"}),
      preparationFingerprint:()=>fingerprint,
      fence:async()=>({active:0,release(){}}),
      stop:async()=>{
        expect(new MacosUpdateTransactionStore(f.store.path).read()?.preparationIntent).toBe(changed || (attempts>0 && retryEdit)?"superseded":"unchanged");
        fingerprint="stop-write";
        if(++attempts===1)throw Error("partial stop");
      },verify:async()=>true,
    };
    expect((await prepareMacosUpdate(f.store,f.authority,f.request,io)).status).toBe("blocked");
    if(retryEdit)fingerprint="edit-before-retry";
    f.store.resumeInstallationPreparation(f.authority,f.request.transactionId);
    expect((await prepareMacosUpdate(f.store,f.authority,f.request,io)).status).toBe("prepared");
    expect(f.store.read()?.preparationIntent).toBe(changed || retryEdit?"superseded":"unchanged");
    expect(f.store.read()?.postPreparationFingerprint).toBe("stop-write");
    f.authority.releaseAll();
  }
});

test.skipIf(process.platform === "win32")("schema v1 accepts legacy records and strictly validates optional preparation and cancellation markers",async()=>{
  const f=await fixture();
  const legacy=f.store.begin(f.authority,f.request,f.snapshot);
  expect(f.store.read()).toEqual(legacy);
  for(const extra of [{preparationIntent:"other"},{preparationIntent:null},{confirmationCancelled:false},{confirmationCancelled:true},{unexpected:true}]) {
    writeFileSync(f.store.path,JSON.stringify({...legacy,...extra}),{mode:0o600});
    expect(()=>f.store.read()).toThrow();
  }
  writeFileSync(f.store.path,JSON.stringify(legacy),{mode:0o600});
  f.store.transition(f.authority,f.request.transactionId,"prepared","stop-write");
  f.store.resumeInstallationPreparation(f.authority,f.request.transactionId);
  expect(f.store.recordPreparationIntent(f.authority,f.request.transactionId,"new-baseline").preparationIntent).toBe("superseded");
  f.authority.releaseAll();
});

test.skipIf(process.platform === "win32")("a crash without a post-stop baseline conservatively supersedes restoration on retry",async()=>{
  const f=await fixture();
  f.store.begin(f.authority,f.request,{...f.snapshot,intentFingerprint:"original"});
  f.store.recordPreparationIntent(f.authority,f.request.transactionId,"original");
  const result=await prepareMacosUpdate(f.store,f.authority,f.request,{
    capture:async()=>{throw Error("must retain original");},preparationFingerprint:()=>"possibly-stop-write",
    fence:async()=>({active:0,release(){}}),stop:async()=>{},verify:async()=>true,
  });
  expect(result.status).toBe("prepared");expect(result.transaction.preparationIntent).toBe("superseded");
  f.authority.releaseAll();
});
