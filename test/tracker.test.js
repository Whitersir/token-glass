import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blankContext, parseRecord } from '../src/parser.js';
import { Tracker } from '../src/scanner.js';
import { buildReport, dateKey, exportCsv } from '../src/report.js';
import { createServer } from '../src/server.js';
import { acquireLock } from '../src/lock.js';
import { readConfig } from '../src/config.js';

const timestamp = '2026-11-10T17:00:00.000Z';
function event(total, last = total, time = timestamp) {
  return { type:'event_msg', timestamp:time, payload:{ type:'token_count', info:{ total_token_usage:total, last_token_usage:last } } };
}
const usage = (input=100, output=20, cached=40) => ({ input_tokens:input, output_tokens:output, cached_input_tokens:cached, reasoning_output_tokens:5 });
const meta = { type:'session_meta', payload:{ id:'session-a', cwd:'D:/工作/测试项目' } };
const turn = { type:'turn_context', payload:{ model:'test-model' } };
const lines = objects => objects.map(obj => JSON.stringify(obj)).join('\n') + '\n';
const configFor = root => ({ timezone:'Asia/Shanghai', refreshSeconds:30, sources:[{name:'codex', enabled:true, roots:[root]}] });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'token-meter-test-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const logs = path.join(root,'logs'); await fs.mkdir(logs);
  return { root, logs, data:path.join(root,'data'), file:path.join(logs,'rollout.jsonl') };
}

test('Codex splits cached input; reasoning remains a subset of output', () => {
  const context = blankContext();
  parseRecord(meta,'codex',context,'f'); parseRecord(turn,'codex',context,'f');
  const row = parseRecord(event(usage()),'codex',context,'f');
  assert.equal(row.input,60); assert.equal(row.cacheRead,40); assert.equal(row.total,120); assert.equal(row.reasoning,5);
  assert.equal(row.model,'test-model'); assert.equal(row.project,'D:/工作/测试项目');
  assert.equal(parseRecord(event(usage()),'codex',context,'f'),null);
});

test('Codex uses cumulative delta when the same last usage is repeated', () => {
  const context = blankContext();
  parseRecord(event(usage()),'codex',context,'f');
  const row = parseRecord(event(usage(170,35,60),usage(70,15,20),'2026-11-11T00:00:00Z'),'codex',context,'f');
  assert.equal(row.total,85); assert.equal(row.input,50); assert.equal(row.cacheRead,20); assert.equal(row.output,15);
  assert.equal(parseRecord(event(usage(170,35,60),usage(70,15,20),'2026-11-11T00:00:01Z'),'codex',context,'f'),null);
});

test('Codex seeded history counts the last request instead of inherited totals', () => {
  const row = parseRecord(event(usage(10000,1000,1000),usage(100,20,40)),'codex',blankContext(),'f');
  assert.equal(row.total,120);
});

test('Codex handles counter resets and zero reset sentinels without rebilling the last turn', () => {
  const context = blankContext();
  parseRecord(event(usage()),'codex',context,'f');
  assert.equal(parseRecord(event(usage(0,0,0),usage()),'codex',context,'f'),null);
  const row = parseRecord(event(usage(30,10,10),usage(30,10,10),'2026-11-11T00:00:00Z'),'codex',context,'f');
  assert.equal(row.total,40);
});

test('Claude usage keeps separate cache counters and excludes message content from saved record', () => {
  const row = parseRecord({ type:'assistant', timestamp, cwd:'D:/private', sessionId:'s', message:{ id:'m1', model:'claude-test', content:'PRIVATE PROMPT', usage:{ input_tokens:100, output_tokens:20, cache_read_input_tokens:40, cache_creation_input_tokens:10 } } },'claude',blankContext(),'f');
  assert.equal(row.total,170); assert.equal(row.input,100); assert.equal(row.cacheWrite,10);
  assert.ok(!JSON.stringify(row).includes('PRIVATE PROMPT'));
  assert.equal(parseRecord({type:'user',timestamp,message:{usage:{input_tokens:100}}},'claude',blankContext(),'f'),null);
});

test('missing timestamps and irrelevant records are ignored', () => {
  const obj = event(usage()); delete obj.timestamp;
  assert.equal(parseRecord(obj,'codex',blankContext(),'f'),null);
  assert.equal(parseRecord({type:'token_usage_record',timestamp,payload:{usage:usage()}},'codex',blankContext(),'f'),null);
  assert.equal(parseRecord(null,'codex',blankContext(),'f'),null);
});

test('repeated scan and reload are idempotent; appended events use persisted baselines', async t => {
  const f = await fixture(t); await fs.writeFile(f.file,lines([meta,turn,event(usage())]));
  let tracker = await new Tracker(configFor(f.logs),f.data).load();
  const first = await tracker.sync(); assert.equal(first.addedRecords,1);
  const second = await tracker.sync(); assert.equal(second.addedRecords,0); assert.equal(second.bytesRead,0);
  tracker = await new Tracker(configFor(f.logs),f.data).load();
  await fs.appendFile(f.file, lines([event(usage(170,35,60),usage(70,15,20),'2026-11-11T00:00:00Z')]));
  assert.equal((await tracker.sync()).addedRecords,1);
  const report = buildReport(tracker.state,tracker.config); assert.equal(report.totals.total,205); assert.equal(report.totals.requests,2);
});

test('partial UTF-8 / JSON lines are retried after the next newline', async t => {
  const f = await fixture(t); const buffer = Buffer.from(lines([meta,turn,event(usage())]));
  const split = Buffer.byteLength(JSON.stringify(meta).split('测试')[0]) + 1;
  await fs.writeFile(f.file,buffer.subarray(0,split));
  const tracker = await new Tracker(configFor(f.logs),f.data).load();
  assert.equal((await tracker.sync()).addedRecords,0);
  await fs.appendFile(f.file,buffer.subarray(split));
  await tracker.sync(); const row = Object.values(tracker.state.records)[0];
  assert.equal(row.project,'D:/工作/测试项目'); assert.equal(row.total,120);
});

test('malformed completed lines do not prevent later records from importing', async t => {
  const f = await fixture(t); await fs.writeFile(f.file,'{bad json}\n'+lines([meta,turn,event(usage())]));
  const tracker = await new Tracker(configFor(f.logs),f.data).load();
  const result = await tracker.sync(); assert.equal(result.malformedLines,1); assert.equal(result.addedRecords,1);
});

test('copied logs and repeated root paths do not duplicate usage', async t => {
  const f = await fixture(t); await fs.writeFile(f.file,lines([meta,turn,event(usage())]));
  await fs.copyFile(f.file,path.join(f.logs,'copied.jsonl'));
  const config = configFor(f.logs); config.sources[0].roots.push(f.logs);
  const tracker = await new Tracker(config,f.data).load(); await tracker.sync();
  assert.equal(buildReport(tracker.state,config).totals.total,120);
});

test('file truncation and rewritten prefixes are rescanned while retaining deduplication', async t => {
  const f = await fixture(t); await fs.writeFile(f.file,lines([meta,turn,event(usage())]));
  const tracker = await new Tracker(configFor(f.logs),f.data).load(); await tracker.sync();
  await fs.writeFile(f.file,lines([meta,turn,event(usage()),event(usage(150,30,60),usage(50,10,20),'2026-11-11T00:00:00Z')]));
  await tracker.sync(); assert.equal(Object.keys(tracker.state.records).length,2);
  await fs.writeFile(f.file,lines([meta,turn,event(usage())])); await tracker.sync();
  assert.equal(buildReport(tracker.state,tracker.config).totals.total,180);
});

test('Claude streamed revisions update usage under a stable message ID', async t => {
  const f = await fixture(t); const config = configFor(f.logs); config.sources[0].name='claude';
  const row = (output) => ({type:'assistant',timestamp,message:{id:'m',model:'test',usage:{input_tokens:100,output_tokens:output}}});
  await fs.writeFile(f.file,lines([row(1)])); const tracker = await new Tracker(config,f.data).load(); await tracker.sync();
  await fs.appendFile(f.file,lines([row(20)])); const result = await tracker.sync();
  assert.equal(result.updatedRecords,1); assert.equal(buildReport(tracker.state,config).totals.total,120);
});

test('saved usage contains neither prompts, completions nor credentials', async t => {
  const f = await fixture(t);
  const secret = 'DO_NOT_STORE_THIS_PROMPT_OR_KEY';
  await fs.writeFile(f.file,lines([{...meta,payload:{...meta.payload,base_instructions:secret}},turn,{type:'response_item',payload:{content:secret}},event(usage())]));
  const tracker = await new Tracker(configFor(f.logs),f.data).load(); await tracker.sync();
  const saved = await fs.readFile(path.join(f.data,'usage.json'),'utf8'); assert.ok(!saved.includes(secret));
});

test('concurrent sync calls share one operation; a failed save does not commit cursors', async t => {
  const f = await fixture(t); await fs.writeFile(f.file,lines([meta,turn,event(usage())]));
  const tracker = await new Tracker(configFor(f.logs),f.data).load();
  const a=tracker.sync(), b=tracker.sync(); assert.equal(a,b); await a;
  await fs.appendFile(f.file,lines([event(usage(150,30,60),usage(50,10,20),'2026-11-11T00:00:00Z')]));
  await fs.mkdir(path.join(f.data,'usage.json.'+process.pid+'.tmp'));
  await assert.rejects(tracker.sync()); assert.equal(Object.keys(tracker.state.records).length,1);
  await fs.rmdir(path.join(f.data,'usage.json.'+process.pid+'.tmp'));
  assert.equal((await tracker.sync()).addedRecords,1);
});

test('date filters use the configured timezone and disabled sources stay hidden', () => {
  assert.equal(dateKey(timestamp,'Asia/Shanghai'),'2026-11-11');
  assert.equal(dateKey(timestamp,'UTC'),'2026-11-10');
  const row = parseRecord(event(usage()),'codex',blankContext(),'f');
  const state = { records:{a:row},lastSync:null,lastResult:null };
  const config = configFor('f');
  assert.equal(buildReport(state,config,{from:'2026-11-11',to:'2026-11-11'}).totals.total,120);
  assert.equal(buildReport(state,config,{to:'2026-11-10'}).totals.total,0);
  assert.equal(buildReport(state,config,{model:'different'}).totals.total,0);
  config.sources[0].enabled=false; assert.equal(buildReport(state,config).totals.total,0);
});

test('CSV is BOM encoded, quoted and protects formula-like text', () => {
  const csv = exportCsv([{timestamp,source:'codex',model:'=HYPERLINK("bad")',project:'A,B',input:1}]);
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"')); assert.ok(csv.includes('"A,B"'));
});

test('historical baseline adds to lifetime only, and never inflates today or filtered periods', () => {
  const row = parseRecord(event(usage()),'codex',blankContext(),'f');
  const state = {records:{a:row},lastSync:null,lastResult:null};
  const config = configFor('f'); config.historicalTokens={codex:1000000,claude:0};
  const report = buildReport(state,config,{from:'2026-11-11',to:'2026-11-11',source:'codex'});
  assert.equal(report.lifetime.total,1000120); assert.equal(report.lifetime.historicalTokens,1000000);
  assert.equal(report.totals.total,120);
  assert.equal(buildReport(state,config,{to:'2026-11-01'}).totals.total,0);
  assert.equal(buildReport(state,config,{to:'2026-11-01'}).lifetime.total,1000120);
  config.sources[0].enabled=false; assert.equal(buildReport(state,config).lifetime.total,0);
});

test('app lock blocks another writer and is released safely', async t => {
  const f = await fixture(t); const release = await acquireLock(f.data);
  await assert.rejects(acquireLock(f.data),/已经运行/); await release();
  const again = await acquireLock(f.data); await again();
});

test('corrupt persisted data fails closed instead of silently replacing it', async t => {
  const f = await fixture(t); await fs.mkdir(f.data); await fs.writeFile(path.join(f.data,'usage.json'),'{broken');
  await assert.rejects(new Tracker(configFor(f.logs),f.data).load(),/原文件已保留/);
  assert.equal(await fs.readFile(path.join(f.data,'usage.json'),'utf8'),'{broken');
});

test('HTTP serves local assets and report; blocks foreign origins and invalid dates', async t => {
  const f = await fixture(t); const tracker = await new Tracker(configFor(f.logs),f.data).load();
  const server = createServer(tracker,{onError:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const base='http://127.0.0.1:'+server.address().port;
  const page=await fetch(base); assert.equal(page.status,200); assert.ok((await page.text()).includes('本地用量'));
  assert.ok(page.headers.get('content-security-policy').includes("default-src 'self'"));
  assert.equal((await fetch(base+'/api/report')).status,200);
  assert.equal((await fetch(base+'/api/report?from=invalid')).status,400);
  assert.equal((await fetch(base+'/api/report?from=2026-11-12&to=2026-11-01')).status,400);
  assert.equal((await fetch(base+'/api/report',{headers:{Origin:'https://outside.example'}})).status,403);
  assert.equal((await fetch(base+'/api/sync',{method:'POST'})).status,403);
  assert.equal((await fetch(base+'/api/sync',{method:'POST',headers:{Origin:base,'X-Token-Meter':'local'}})).status,200);
  assert.equal((await fetch(base+'/data/usage.json')).status,404);
  assert.equal((await fetch(base+'/api/export.csv')).status,200);
});

test('custom source roots and timezone validation', async t => {
  const f = await fixture(t); const file=path.join(f.root,'config.json');
  await fs.writeFile(file,JSON.stringify({timezone:'Asia/Shanghai',sources:{codex:{roots:[f.logs]},claude:{enabled:false}}}));
  const config=await readConfig(file,{}); assert.deepEqual(config.sources[0].roots,[f.logs]); assert.equal(config.sources[1].enabled,false);
  await fs.writeFile(file,JSON.stringify({timezone:'Wrong/Zone'})); await assert.rejects(readConfig(file,{}));
});

