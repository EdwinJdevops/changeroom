import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const versionPattern = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/u;

export async function readCandidate(directory, version) {
  if (!versionPattern.test(version)) throw new Error('Invalid candidate version');
  const file = await open(resolve(directory, `${version}.txt`), 'r');
  try {
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes);
    if (bytesRead > 65536 || !(await file.stat()).isFile()) throw new Error('Expected a release artifact under 64 KiB');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export function openLedger(path, room) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS change_requests (
      room TEXT NOT NULL, id TEXT NOT NULL, release TEXT NOT NULL, policy TEXT NOT NULL,
      proposed_by TEXT NOT NULL, proposed_at INTEGER NOT NULL, approved_by TEXT,
      approval_message TEXT, receipt_sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(room,id), UNIQUE(room,approval_message)
    );
    CREATE TABLE IF NOT EXISTS staging (
      room TEXT PRIMARY KEY, release TEXT NOT NULL, request_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      room TEXT NOT NULL, id TEXT NOT NULL, sha TEXT NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(room,id)
    );`);
  return {
    propose(event, release, instructions, bytes) {
      const policy = digest(instructions);
      const id = digest(JSON.stringify([room, event.id])).slice(0, 24);
      db.exec('BEGIN IMMEDIATE');
      try {
      db.prepare(`INSERT OR IGNORE INTO change_requests
        (room,id,release,policy,proposed_by,proposed_at) VALUES (?,?,?,?,?,?)`)
        .run(room, id, release, policy, event.id, event.timestamp);
      db.prepare('INSERT OR IGNORE INTO candidates VALUES (?,?,?,?)').run(room,id,digest(bytes),bytes);
      db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return id;
    },
    releaseFor(id) { return db.prepare('SELECT release FROM change_requests WHERE room=? AND id=?').get(room,id)?.release; },
    approve(event, id, instructions, currentBytes) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const request = db.prepare('SELECT * FROM change_requests WHERE room=? AND id=?').get(room, id);
        let result = 'unknown proposal';
        if (request?.approved_by) result = 'already executed';
        else if (request && event.timestamp <= request.proposed_at) result = 'approval precedes proposal';
        else if (request && request.policy !== digest(instructions)) result = 'room instructions changed';
        else if (request && (!currentBytes || db.prepare('SELECT sha FROM candidates WHERE room=? AND id=?').get(room,id)?.sha !== digest(currentBytes))) result = 'candidate bytes changed or are unavailable';
        else if (request && db.prepare('SELECT 1 FROM change_requests WHERE room=? AND proposed_at>?').get(room,request.proposed_at)) result = 'newer proposal exists';
        else if (request) {
          db.prepare('UPDATE change_requests SET approved_by=?, approval_message=? WHERE room=? AND id=?')
            .run(event.sender, event.id, room, id);
          db.prepare(`INSERT INTO staging VALUES (?,?,?) ON CONFLICT(room) DO UPDATE SET
            release=excluded.release, request_id=excluded.request_id`).run(room, request.release, id);
          result = 'executed';
        }
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    pendingReceipts() {
      return db.prepare('SELECT id,release,approval_message FROM change_requests WHERE room=? AND approved_by IS NOT NULL AND receipt_sent=0').all(room);
    },
    markReceipt(id) { db.prepare('UPDATE change_requests SET receipt_sent=1 WHERE room=? AND id=?').run(room,id); },
    staging() { return db.prepare('SELECT release,request_id FROM staging WHERE room=?').get(room); },
    close() { db.close(); }
  };
}

export function switchClient({ baseUrl, agent, key, room }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || (base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)))) {
    throw new Error('Use HTTPS or a loopback HTTP Switch server');
  }
  const endpoint = `${base.href.replace(/\/$/, '')}/agents/${encodeURIComponent(agent)}`;
  async function post(path, body) {
    const response = await fetch(endpoint + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Switch ${path} returned HTTP ${response.status}`);
    return response.json();
  }
  return {
    async instructions() {
      const { result } = await post('/ops/get_room_detail', { room_id: room });
      if (result?.id !== room || !Object.hasOwn(result, 'instructions') ||
        (result.instructions !== null && typeof result.instructions !== 'string')) throw new Error('Unexpected Switch room detail');
      return result.instructions ?? '';
    },
    async history(since) {
      const { result } = await post('/ops/read_context', { room_id: room, since, limit: 100 });
      if (!Array.isArray(result?.threads) || result.truncated !== false) throw new Error('Switch history incomplete. Use a dedicated demo room with fewer than 100 events per run.');
      return result.threads.flatMap(({ root, replies }) => [root, ...replies]).sort((a,b) => a.timestamp - b.timestamp);
    },
    post: content => post('/message', { room_id: room, content })
  };
}

export async function runPoll({ client, ledger, since, proposer, approver, seen, candidate }) {
  for (const event of await client.history(since)) {
    if (event.kind !== 'message' || event.on_behalf_of || event.sender_kind === 'platform' ||
      typeof event.id !== 'string' || !Number.isSafeInteger(event.timestamp) ||
      typeof event.body !== 'string' || seen.has(event.id)) continue;
    const proposal = /^change propose (v?\d{1,6}\.\d{1,6}\.\d{1,6}) ([a-f0-9]{64})$/u.exec(event.body.trim());
    const approval = /^change approve ([a-f0-9]{24})$/u.exec(event.body.trim());
    if (proposal && event.sender === proposer) {
      const bytes = await candidate(proposal[1]).catch(() => null);
      if (!bytes || digest(bytes) !== proposal[2]) await client.post('Staging unchanged: reviewed artifact hash does not match the candidate. Review the current file.');
      else {
        const id = ledger.propose(event, proposal[1], await client.instructions(), bytes);
        await client.post(`Proposed staging promotion to ${proposal[1]} (SHA-256 ${proposal[2]}). Reviewer: reply with change approve ${id}.`);
      }
    } else if (approval && event.sender === approver) {
      const release = ledger.releaseFor(approval[1]);
      const bytes = release ? await candidate(release).catch(() => null) : null;
      const result = ledger.approve(event, approval[1], await client.instructions(), bytes);
      if (result !== 'executed' && result !== 'already executed') await client.post(`Staging unchanged: ${result}.`);
    }
    seen.add(event.id);
  }
  for (const receipt of ledger.pendingReceipts()) {
    await client.post(`Staging promoted to ${receipt.release}. Receipt ${receipt.id}. Approval message ${receipt.approval_message}.`);
    ledger.markReceipt(receipt.id);
  }
}

async function main() {
  const { SWITCH_URL: baseUrl, SWITCH_AGENT_ID: agent, SWITCH_AGENT_KEY: key,
    SWITCH_ROOM_ID: room, CHANGE_PROPOSER: proposer, CHANGE_APPROVER: approver } = process.env;
  if (process.argv.includes('--status')) {
    if (!room) throw new Error('Set SWITCH_ROOM_ID to read the staging pointer.');
    const db = new DatabaseSync(process.env.CHANGE_DB ?? 'changeroom.sqlite', { readOnly: true });
    try {
      const staging = db.prepare('SELECT release,request_id FROM staging WHERE room=?').get(room);
      if (staging) {
        const candidate = db.prepare('SELECT sha FROM candidates WHERE room=? AND id=?').get(room,staging.request_id);
        console.log(JSON.stringify({ ...staging, artifact_sha256: candidate?.sha ?? null }));
      } else console.log(JSON.stringify({ release: null, request_id: null }));
    } finally { db.close(); }
    return;
  }
  if (process.argv.includes('--identify')) {
    if (![baseUrl, agent, key, room].every(Boolean)) throw new Error('Set the four SWITCH variables first.');
    const client = switchClient({ baseUrl, agent, key, room });
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    for (const event of await client.history(since)) {
      if (event.kind === 'message' && event.body === 'change identity') {
        console.log(JSON.stringify({ id: event.sender, name: event.sender_name, kind: event.sender_kind, onBehalfOf: event.on_behalf_of }));
      }
    }
    return;
  }
  if (![baseUrl, agent, key, room, proposer, approver].every(Boolean) || proposer === approver) {
    throw new Error('Set the six Switch and ChangeRoom variables in README. Proposer and approver must be distinct.');
  }
  const client = switchClient({ baseUrl, agent, key, room });
  const ledger = openLedger(process.env.CHANGE_DB ?? 'changeroom.sqlite', room);
  const since = new Date().toISOString();
  const seen = new Set();
  console.log('ChangeRoom watching configured Switch room. Post a new proposal after startup.');
  try {
    while (true) {
      await runPoll({ client, ledger, since, proposer, approver, seen,
        candidate: version => readCandidate(process.env.CHANGE_ARTIFACT_DIR ?? 'releases', version) });
      await delay(1500);
    }
  } finally { ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
