import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Tracker } from '../src/scanner.js';
import { buildReport, exportCsv } from '../src/report.js';
import { createServer } from '../src/server.js';
import { validateSnapshot, readBridgeKey } from '../src/browser-bridge.js';

const coreContext = vm.createContext({ URL });
vm.runInContext(await fs.readFile(new URL('../browser-extension/core.js', import.meta.url), 'utf8'), coreContext);
const core = coreContext.TokenMeterWeb;
const snapshot = (extra = {}) => ({source:'chatgpt-web',session:'a'.repeat(64),instance:'b'.repeat(32),input:10,output:20,active:true,visible:true,estimator:'unicode-v1',capturedAt:'2026-11-11T02:00:00Z',...extra});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-web-test-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const config = {timezone:'Asia/Shanghai',refreshSeconds:30,browserBridge:{enabled:true},historicalTokens:{codex:1000000},sources:[{name:'codex',enabled:true,roots:[]},{name:'chatgpt-web',enabled:true,roots:[]},{name:'claude-web',enabled:true,roots:[]}]};
  return {root,config,tracker:await new Tracker(config, root).load()};
}

test('web estimator handles CJK, Latin, punctuation and empty text; restricts website origins', () => {
  assert.equal(core.estimateText('你好'),3); assert.equal(core.estimateText('hello'),2); assert.equal(core.estimateText('   '),0);
  assert.ok(core.estimateText('你好 world!') > core.estimateText('world'));
  assert.equal(core.sourceForUrl('https://chatgpt.com/c/abc'),'chatgpt-web');
  assert.equal(core.sourceForUrl('https://claude.ai/chat/abc'),'claude-web');
  for (const url of ['https://chatgpt.com.evil.example/c/abc','https://evil.example','http://chatgpt.com']) assert.equal(core.sourceForUrl(url),null);
  assert.equal(core.conversationKey('https://chatgpt.com/g/g-test/c/abc?x=1'),'chatgpt-web:abc');
  assert.equal(core.conversationKey('https://claude.ai/settings'),'claude-web:new-chat');
});

test('web capture only reads message nodes, excludes hidden and nested response nodes', () => {
  const element = (text, {hidden=false,nested=false}={}) => ({innerText:text,parentElement:{closest:()=>nested?{}:null},getClientRects:()=>hidden?[]:[{}],closest:()=>null,querySelector:()=>null,matches:()=>false});
  const doc = { querySelectorAll: selector => selector.includes('"user"') ? [element('你好'),element('private hidden',{hidden:true})] : [element('hello'),element('duplicate',{nested:true})] };
  const counts = core.collect(doc,'chatgpt-web');
  assert.equal(counts.input,3); assert.equal(counts.output,2); assert.equal(counts.messages,2);
});

test('web snapshots survive reloads, duplicate tabs, streaming and next-day growth without doubling', async t => {
  const {tracker,root,config} = await fixture(t);
  const day1 = new Date('2026-11-11T02:00:00Z'), day2 = new Date('2026-11-12T02:00:00Z');
  assert.equal((await tracker.ingestWebSnapshot(snapshot(),day1)).addedTokens,30);
  assert.equal((await tracker.ingestWebSnapshot(snapshot({instance:'c'.repeat(32)}),day1)).addedTokens,0);
  assert.equal((await tracker.ingestWebSnapshot(snapshot({input:2,output:4}),day1)).addedTokens,0);
  assert.equal((await tracker.ingestWebSnapshot(snapshot({output:35}),day1)).addedTokens,15);
  const reloaded = await new Tracker(config,root).load();
  assert.equal((await reloaded.ingestWebSnapshot(snapshot({output:35}),day2)).addedTokens,0);
  assert.equal((await reloaded.ingestWebSnapshot(snapshot({input:15,output:45}),day2)).addedTokens,15);
  const report = buildReport(reloaded.state,config,{source:'chatgpt-web'});
  assert.equal(report.lifetime.total,60); assert.equal(report.lifetime.historicalTokens,0);
  assert.equal(report.totals.estimatedTokens,60); assert.equal(report.totals.measuredTokens,0); assert.equal(report.measurement,'visible-text');
  assert.deepEqual(report.daily.map(row=>row.total),[45,15]);
  const disk = await fs.readFile(path.join(root,'usage.json'),'utf8');
  assert.ok(!disk.includes('chatgpt.com')); assert.ok(!disk.includes('hello')); assert.ok(exportCsv(Object.values(reloaded.state.records)).includes('visible-text'));
});

test('concurrent scan / browser writes are serialized and failed persistence does not advance counts', async t => {
  const {tracker} = await fixture(t);
  await Promise.all([tracker.sync(),tracker.ingestWebSnapshot(snapshot()),tracker.ingestWebSnapshot(snapshot({output:40})),tracker.sync()]);
  assert.equal(Object.values(tracker.state.records).reduce((sum,row)=>sum+row.total,0),50);
  const original = tracker.dataDir; tracker.dataDir = path.join(original,'missing');
  await assert.rejects(tracker.ingestWebSnapshot(snapshot({output:100})));
  assert.equal(tracker.state.webConversations[`chatgpt-web:${'a'.repeat(64)}`].output,40);
  tracker.dataDir = original;
  assert.equal((await tracker.ingestWebSnapshot(snapshot({output:100}))).addedTokens,60);
});

test('offline replays update counts but cannot revive stale webpage presence; sources can be disabled', async t => {
  const {tracker,root,config} = await fixture(t);
  await tracker.ingestWebSnapshot(snapshot(),new Date('2026-11-12T02:00:00Z'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'browser-presence.json'),'utf8')).pages,[]);
  config.sources.find(source=>source.name==='chatgpt-web').enabled=false;
  assert.throws(()=>tracker.ingestWebSnapshot(snapshot()),/停用/);
  assert.equal(buildReport(tracker.state,config).totals.total,0);
});

test('bridge rejects content, unsafe counts, unrelated sources and malformed identity', () => {
  for (const value of [snapshot({text:'PRIVATE CHAT'}),snapshot({source:'codex'}),snapshot({input:-1}),snapshot({output:Infinity}),snapshot({session:'bad'}),snapshot({capturedAt:'bad'})]) assert.throws(()=>validateSnapshot(value));
});

test('authenticated extension ingress works while other origins and local control routes remain blocked', async t => {
  const {tracker,root} = await fixture(t), key = await readBridgeKey(root);
  assert.equal(key,await readBridgeKey(root));
  const server=createServer(tracker,{bridgeKey:key,onError:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`, origin=`chrome-extension://${'a'.repeat(32)}`;
  const post=(payload,headers={})=>fetch(base+'/api/browser-usage',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...headers},body:JSON.stringify(payload)});
  assert.equal((await post(snapshot())).status,200);
  assert.equal((await post(snapshot(),{Authorization:'Bearer wrong'})).status,403);
  assert.equal((await post(snapshot(),{Origin:'https://chatgpt.com'})).status,403);
  assert.equal((await post(snapshot({text:'PRIVATE'}))).status,400);
  assert.equal((await post({padding:'x'.repeat(5000)})).status,413);
  assert.equal((await fetch(base+'/api/report',{headers:{Origin:origin}})).status,403);
  assert.equal((await fetch(base+'/api/stop',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${key}`}})).status,403);
  const report=await (await fetch(base+'/api/report?source=chatgpt-web')).json();
  assert.equal(report.totals.total,30); assert.equal(report.measurement,'visible-text');
  assert.equal((await fetch(base+'/api/report?source=claude-web')).status,200);
  const preflight=await fetch(base+'/api/browser-usage',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST'}});
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
});

test('Chrome worker queues only counts offline, retries successfully, and rejects other websites', async () => {
  const stored = {}, handlers = {}, calls = [];
  let offline = true;
  const chrome = {
    runtime:{id:'test-extension',onMessage:{addListener:fn=>{handlers.message=fn;}},onStartup:{addListener:()=>{}}},
    alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},
    storage:{local:{get:async()=>structuredClone(stored),set:async value=>Object.assign(stored,structuredClone(value))}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
  };
  const context=vm.createContext({URL,chrome,AbortSignal,console,fetch:async (url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    if (offline) throw new Error('offline');
    return {ok:true,json:async()=>({accepted:true,input:10,output:20})};
  }});
  context.importScripts = (...files)=>files.forEach(file=>vm.runInContext(file==='core.js'?coreSource:'globalThis.TOKEN_METER_CONNECTION={origin:"http://127.0.0.1:7681",key:"fixture-key"};',context));
  const coreSource=await fs.readFile(new URL('../browser-extension/core.js',import.meta.url),'utf8');
  vm.runInContext(await fs.readFile(new URL('../browser-extension/background.js',import.meta.url),'utf8'),context);
  const deliver=(message,sender)=>new Promise(resolve=>{
    const keep=handlers.message(message,sender,resolve);
    if (!keep) resolve(undefined);
  });
  const sender={id:'test-extension',url:'https://chatgpt.com/c/test',tab:{id:1}};
  const result=await deliver({type:'token-meter-snapshot',snapshot:snapshot({text:'PRIVATE CONTENT'})},sender);
  assert.equal(result.queued,1); assert.equal(Object.keys(stored.pending).length,1);
  assert.ok(!JSON.stringify(stored).includes('PRIVATE')); assert.ok(!JSON.stringify(calls).includes('PRIVATE'));
  assert.equal((await deliver({type:'token-meter-snapshot',snapshot:snapshot()},{...sender,url:'https://unrelated.example'})).ok,false);
  assert.ok(calls.every(call=>call.url==='http://127.0.0.1:7681/api/browser-usage'));
  offline=false;
  const retry=await deliver({type:'token-meter-status'},{id:'test-extension'});
  assert.equal(retry.queued,0); assert.equal(retry.status['chatgpt-web'].ok,true);
});

