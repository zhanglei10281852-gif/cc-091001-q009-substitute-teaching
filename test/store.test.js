import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('Store 重放 JSONL：实体以最新快照为准，审计与幂等键全量保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-store-'));
  try {
    const file = join(dir, 'log.jsonl');
    const s1 = new Store(file);
    await s1.load();
    s1.absences.set('A', { id: 'A', state: 'inviting' });
    s1.invitations.set('I', { id: 'I', state: 'pending' });
    s1.keys.set('respond:k1', { refId: 'I', detail: { action: 'accept' } });
    s1.audit.push({ seq: 1, type: 'reported', absenceId: 'A' });
    await s1.commit([
      { t: 'absence', data: s1.absences.get('A') },
      { t: 'invitation', data: s1.invitations.get('I') },
      { t: 'key', key: 'respond:k1', data: s1.keys.get('respond:k1') },
      { t: 'audit', data: s1.audit[0] },
    ]);
    // 同一份缺岗的后续快照
    s1.absences.set('A', { id: 'A', state: 'covered' });
    s1.audit.push({ seq: 2, type: 'covered', absenceId: 'A' });
    await s1.commit([
      { t: 'absence', data: s1.absences.get('A') },
      { t: 'audit', data: s1.audit[1] },
    ]);
    await s1.compact();
    await s1.close();

    const s2 = new Store(file);
    await s2.load();
    assert.equal(s2.absences.get('A').state, 'covered');
    assert.equal(s2.invitations.get('I').state, 'pending');
    assert.deepEqual(s2.keys.get('respond:k1'), { refId: 'I', detail: { action: 'accept' } });
    assert.deepEqual(s2.audit.map((x) => x.seq), [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Store 日志文件缺失时静默开始，损坏行给出明确错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-store-'));
  try {
    const ok = new Store(join(dir, 'absent.jsonl'));
    await ok.load();
    assert.equal(ok.absences.size, 0);

    const { writeFile } = await import('node:fs/promises');
    const bad = join(dir, 'bad.jsonl');
    await writeFile(bad, '{"t":"absence","data":{}}\n{not json\n');
    const broken = new Store(bad);
    await assert.rejects(broken.load(), /日志第 2 行损坏/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
