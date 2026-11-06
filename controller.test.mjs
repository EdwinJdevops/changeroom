import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLedger, runPoll, switchClient } from './controller.mjs';

test('Switch HTTP contract, stale approval, spoofed sender, promotion and restart', async t => {
  const events = [], posts = [];
  let policy = 'require one reviewer';
  let unavailable = false;
  const server = createServer(async (req,res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const args = JSON.parse(body);
    if (unavailable || req.headers.authorization !== 'Bearer fixture-only' || args.room_id !== 'test-room') {
      res.writeHead(403).end();
      return;
    }
    let result;
    if (req.url === '/agents/controller/ops/read_context') result = { threads: events.map(root => ({root,replies:[]})), truncated:false };
    else if (req.url === '/agents/controller/ops/get_room_detail') result = { id:'test-room',instructions:policy };
    else if (req.url === '/agents/controller/message') { posts.push(args.content); result = {ok:true}; }
    else { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({result}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const path = join(mkdtempSync(join(tmpdir(),'changeroom-')),'test.sqlite');
  let ledger = openLedger(path,'test-room');
  t.after(() => ledger.close());
  const client = switchClient({baseUrl:`http://127.0.0.1:${server.address().port}`,agent:'controller',key:'fixture-only',room:'test-room'});
  const seen = new Set();
  let bytes = Buffer.from('reviewed release');
  const poll = () => runPoll({client,ledger,seen,since:'2026-11-05T00:00:00Z',proposer:'agent',approver:'human',candidate: async () => bytes});
  const proposal = version => `change propose ${version} ${createHash('sha256').update(bytes).digest('hex')}`;
  const add = (sender,body,extra={}) => events.push({ id:`e${events.length}`,timestamp:events.length+1,kind:'message',sender,body,...extra });
  const proposalId = () => posts.at(-1).match(/approve ([a-f0-9]{24})/)[1];
  add('agent',proposal('1.2.3')); await poll();
  const old = proposalId();
  add('agent',`change approve ${old}`); await poll();
  assert.equal(ledger.staging(),undefined);
  policy = 'policy revision two';
  add('human',`change approve ${old}`); await poll();
  assert.match(posts.at(-1),/instructions changed/);
  assert.equal(ledger.staging(),undefined);
  add('agent',proposal('1.2.4')); await poll();
  const changed = proposalId();
  bytes = Buffer.from('replacement bytes with the same version');
  add('human',`change approve ${changed}`); await poll();
  assert.match(posts.at(-1),/candidate bytes changed/);
  assert.equal(ledger.staging(),undefined);
  add('agent',proposal('1.2.4')); await poll();
  const fresh = proposalId();
  add('human',`change approve ${fresh}`,{sender_kind:'platform'}); await poll();
  assert.equal(ledger.staging(),undefined);
  add('human',`change approve ${fresh}`); await poll();
  assert.equal(ledger.staging().release,'1.2.4');
  assert.equal(ledger.staging().request_id,fresh);
  ledger.close(); ledger = openLedger(path,'test-room');
  add('human',`change approve ${fresh}`); await poll();
  assert.equal(posts.filter(post => post.startsWith('Staging promoted')).length,1);
  unavailable = true;
  await assert.rejects(poll,/403/);
  assert.equal(ledger.staging().release,'1.2.4');
});

test('a superseded request cannot overwrite staging', t => {
  const ledger = openLedger(':memory:','room');
  t.after(() => ledger.close());
  const bytes = Buffer.from('fixture');
  const old = ledger.propose({id:'p1',timestamp:1},'1.0.0','policy',bytes);
  ledger.propose({id:'p2',timestamp:2},'2.0.0','policy',bytes);
  assert.equal(ledger.approve({id:'a1',timestamp:3,sender:'reviewer'},old,'policy',bytes),'newer proposal exists');
  assert.equal(ledger.staging(),undefined);
});
