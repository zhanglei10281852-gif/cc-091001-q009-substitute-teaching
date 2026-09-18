import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

// 追加式 JSONL 日志：每次状态变更写入一条完整快照记录，启动时重放恢复。
// 写入经单条队列串行化；引擎在同一同步阶段完成全部内存变更后才调用 commit，
// 因此“接受”对唯一人选的确认是原子的：落盘前没有任何异步间隙能插入第二份应答。
export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.absences = new Map();
    this.invitations = new Map();
    this.keys = new Map();
    this.audit = [];
    this._chain = Promise.resolve();
    this._fh = null;
  }

  async load() {
    let text;
    try {
      const fh = await open(this.filePath, 'r');
      text = await fh.readFile('utf8');
      await fh.close();
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const lines = text.split('\n');
    for (const [idx, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`日志第 ${idx + 1} 行损坏: ${err.message}`);
      }
      if (rec.t === 'absence') this.absences.set(rec.data.id, rec.data);
      else if (rec.t === 'invitation') this.invitations.set(rec.data.id, rec.data);
      else if (rec.t === 'key') this.keys.set(rec.key, rec.data);
      else if (rec.t === 'audit') this.audit.push(rec.data);
    }
  }

  async start() {
    await mkdir(dirname(this.filePath), { recursive: true });
    this._fh = await open(this.filePath, 'a');
  }

  // 一批记录一次性串行追加
  commit(records) {
    if (records.length === 0) return this._chain;
    const chunk = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    this._chain = this._chain.then(async () => {
      if (!this._fh) await this.start();
      await this._fh.write(chunk);
      await this._fh.sync();
    });
    return this._chain;
  }

  async close() {
    await this._chain;
    if (this._fh) {
      await this._fh.close();
      this._fh = null;
    }
  }

  // 压缩重写：保留每份实体的最新快照、幂等键与全部审计记录
  async compact() {
    await this._chain;
    const records = [
      ...[...this.absences.values()].map((data) => ({ t: 'absence', data })),
      ...[...this.invitations.values()].map((data) => ({ t: 'invitation', data })),
      ...[...this.keys.entries()].map(([key, data]) => ({ t: 'key', key, data })),
      ...this.audit.map((data) => ({ t: 'audit', data })),
    ];
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await mkdir(dirname(this.filePath), { recursive: true });
    const fh = await open(tmp, 'w');
    await fh.writeFile(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await fh.sync();
    await fh.close();
    await rename(tmp, this.filePath);
    this._fh = await open(this.filePath, 'a');
  }
}
