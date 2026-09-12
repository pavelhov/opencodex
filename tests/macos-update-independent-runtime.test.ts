import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { acquireProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import { assertMacosUpdateAllowsRuntimeStart, MacosUpdateTransactionStore } from "../src/server/macos-update-transaction";
import { assertMacosUpdateAllowsServiceStart, type ServiceDiagnostic, type ServiceInstallState } from "../src/service";
// These macOS fixtures require POSIX permissions, directory fsync, and bundle paths.
// Keep Linux coverage; Windows cannot represent the durability/provenance contract.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(),"ccx-update-independent-"))); roots.push(root);
  const config = join(root,"ccx"); const codex = join(root,"codex"); const home = join(root,"home");
  for (const directory of [config,codex,home]) mkdirSync(directory,{mode:0o700});
  const lock = async () => ({token:"isolated",release(){}});
  const authority = await acquireProxyLifecycleAuthority({includeStart:true,acquireEnsureLock:lock,acquireStartLock:lock});
  const store = new MacosUpdateTransactionStore(join(config,"macos-update-transaction.json"));
  const bundlePath = join(root,"Test.app");
  store.begin(authority,{transactionId:"independent",source:{bundlePath,build:"100"},target:{bundlePath,build:"101"}},{running:false,routing:"native",supervision:"none",process:null,supervisorFingerprint:null});
  store.transition(authority,"independent","prepared"); store.transition(authority,"independent","armed"); authority.releaseAll();
  return {root,config,codex,home,store,bundlePath};
}
test.skipIf(process.platform === "win32")("physical start uses actual paths and refuses bundle, mixed, missing provenance", async () => {
  const f = await fixture();
  const external = join(f.root,"external.ts"); writeFileSync(external,"");
  const bundled = join(f.bundlePath,"Contents","Resources","runtime.ts"); mkdirSync(join(f.bundlePath,"Contents","Resources"),{recursive:true}); writeFileSync(bundled,"");
  expect(assertMacosUpdateAllowsRuntimeStart(f.store,{modulePath:external,executablePath:external})).toBe("independent");
  expect(()=>assertMacosUpdateAllowsRuntimeStart(f.store,{modulePath:bundled,executablePath:bundled})).toThrow();
  expect(()=>assertMacosUpdateAllowsRuntimeStart(f.store,{modulePath:external,executablePath:bundled})).toThrow();
  expect(()=>assertMacosUpdateAllowsRuntimeStart(f.store,{modulePath:join(f.root,"missing"),executablePath:external})).toThrow();
});
test.skipIf(process.platform === "win32")("registered service target is checked independently of the caller", async () => {
  const f = await fixture();
  const diagnostic: ServiceDiagnostic = {supported:true,registrationState:"present",supervisorState:"inactive",installed:true,enabled:true,running:false,viable:false,startable:true,stale:false,conflict:false,backend:"launchd",summary:""};
  const state: ServiceInstallState = {version:3,codexHome:f.codex,codexCommanderHome:f.config,bunPath:"/outside/bun",cliPath:"/outside/ccx",backend:"scheduler"};
  const check = (selected: ServiceInstallState) => assertMacosUpdateAllowsServiceStart(f.store,{diagnose:()=>diagnostic,evidence:()=>[{kind:"valid",path:"fixture",state:selected}],realpath:((path:string)=>path) as typeof import("node:fs").realpathSync,registrationMatches:()=>true});
  expect(check(state)).toBe("independent");
  expect(()=>check({...state,bunPath:`${f.bundlePath}/Contents/Resources/bun`,cliPath:`${f.bundlePath}/Contents/Resources/cli`})).toThrow();
  expect(()=>check({...state,bunPath:`${f.bundlePath}/Contents/Resources/bun`})).toThrow();
});
test.skipIf(process.platform === "win32")("independent autonomous service child serves during armed update without rewriting routing", async () => {
  const f = await fixture();
  const port = await new Promise<number>((resolve,reject)=>{const server=createServer(); server.once("error",reject); server.listen(0,"127.0.0.1",()=>{const value=server.address();const port=typeof value === "object" && value ? value.port : 0;server.close(error=>error?reject(error):resolve(port));});});
  const settings = JSON.stringify({port,hostname:"127.0.0.1",codexAutoStart:true,multiAgentGuidanceEnabled:true,clientIntegrations:{codex:true},defaultProvider:"mock",providers:{mock:{adapter:"openai-chat",baseUrl:"http://127.0.0.1:9/v1",allowPrivateNetwork:true,models:["test"],defaultModel:"test"}}});
  const native = 'model = "native-choice"\n';
  writeFileSync(join(f.config,"config.json"),settings,{mode:0o600}); writeFileSync(join(f.codex,"config.toml"),native,{mode:0o600});
  const child = Bun.spawn([process.execPath,"src/cli/index.ts","start","--port",String(port)],{cwd:join(import.meta.dir,".."),env:{...process.env,HOME:f.home,CODEX_HOME:f.codex,CODEXCOMMANDER_HOME:f.config,CCX_SERVICE:"1",CCX_PROXY_DELEGATED_START:"0"},stdout:"pipe",stderr:"pipe"});
  const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
  try {
    let ready = false;
    for (let attempt=0;attempt<100;attempt++) {
      try { const response=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(200)});if(response.ok){ready=true;break;} } catch {}
      if (child.exitCode !== null) break;
      await Bun.sleep(50);
    }
    if (!ready && child.exitCode !== null) throw Error(await stderr);
    expect(ready).toBe(true);
    expect(readFileSync(join(f.codex,"config.toml"),"utf8")).toBe(native);
    expect(readFileSync(join(f.config,"config.json"),"utf8")).toBe(settings);
    expect(f.store.read()?.phase).toBe("armed");
  } finally {
    child.kill("SIGTERM");
    const timer=setTimeout(()=>child.kill("SIGKILL"),3000);
    await child.exited;clearTimeout(timer);
    await Promise.all([stdout,stderr]);
  }
  expect(readFileSync(join(f.codex,"config.toml"),"utf8")).toBe(native);
  expect(readFileSync(join(f.config,"config.json"),"utf8")).toBe(settings);
},10000);

test("independent service command starts without routing preparation or convergence", async () => {
  const { runServiceLifecycleCommand } = await import("../src/cli/service-command");
  let starts = 0; let writes = 0;
  const lock = async () => ({ token:"isolated", release(){} });
  await runServiceLifecycleCommand(["start"], {
    platform:"darwin", assertEnvironment(){},
    acquireAuthority:()=>acquireProxyLifecycleAuthority({includeStart:true,acquireEnsureLock:lock,acquireStartLock:lock}),
    updateStartDisposition:()=>"independent",
    operations:()=>({install(){throw Error("not install");},start(){starts++;}}),
    armServiceStartDelegation:()=>({token:"isolated",ensureToken:"isolated"}),clearServiceStartDelegation(){},
    reportServing:async()=>true,
    prepareTermination(){writes++;throw Error("routing must be preserved");},
    prepareStart(){writes++;throw Error("routing must be preserved");},
    syncStartedService:async()=>{writes++;throw Error("routing must be preserved");},
    log(){},error(message){throw Error(message);},fail(){throw Error("unexpected refusal");},
  });
  expect(starts).toBe(1); expect(writes).toBe(0);
});

test.skipIf(process.platform === "win32")("independent Ensure preserves routing and cannot start a registered bundled service", async () => {
  const { ensureProxyLifecycleUnderLock } = await import("../src/cli/proxy-lifecycle");
  const { getDefaultConfig } = await import("../src/config");
  const f = await fixture(); const previous = process.env.CODEXCOMMANDER_HOME;
  process.env.CODEXCOMMANDER_HOME = f.config;
  const lock = async () => ({token:"isolated",release(){}});
  const authority = await acquireProxyLifecycleAuthority({includeStart:true,acquireEnsureLock:lock,acquireStartLock:lock});
  const absent: ServiceDiagnostic = {supported:true,registrationState:"absent",supervisorState:"inactive",installed:false,enabled:false,running:false,viable:false,startable:false,stale:false,conflict:false,backend:null,summary:""};
  let writes=0;let starts=0; let live=false;
  const runtime = {pid:1234,port:10100,source:"runtime" as const};
  const io = {
    loadConfig:()=>({...getDefaultConfig(),clientIntegrations:{codex:true}}),
    findLive:async()=>live ? runtime : null,diagnoseService:()=>absent,
    prepareStart:()=>{writes++;throw Error("routing hook must not run");},
    reconcile(){writes++;},syncLive:async()=>{writes++;throw Error("sync must not run");},
    spawnStart:async()=>{starts++;live=true;},waitForProxy:async()=>runtime,waitForReady:async()=>"ready" as const,
  };
  try {
    const result=await ensureProxyLifecycleUnderLock({action:"start",io},authority);
    expect(result.ok).toBe(true);expect(starts).toBe(1);expect(writes).toBe(0);
    live=false;
    const refusal=await ensureProxyLifecycleUnderLock({action:"start",io:{...io,diagnoseService:()=>({...absent,installed:true,registrationState:"present",startable:true}),updateServiceStartDisposition:()=>{throw Error("bundle target blocked");},startService:()=>{starts++;return true;}}},authority);
    expect(refusal.ok).toBe(false);expect(starts).toBe(1);expect(writes).toBe(0);
  } finally {
    authority.releaseAll();
    if(previous===undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME=previous;
  }
});
