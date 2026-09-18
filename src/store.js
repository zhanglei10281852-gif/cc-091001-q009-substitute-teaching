// 持久化：JSON 文件原子落盘（写临时文件后 rename）。
// 所有变更经互斥链串行化，读多写少场景下足够；重启后重新加载，
// 未过期的临时占位继续有效，过期项由领域引擎在加载/访问时清理。

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY = { version: 1, teachers: [], absences: [], invitations: [], auditLog: [] };

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.chain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = structuredClone(EMPTY);
    }
    return this.data;
  }

  // 串行执行一次“读-改-写”，mutator 的返回值会透传给调用方；抛错则不落盘。
  async mutate(mutator) {
    const run = this.chain.then(async () => {
      if (!this.data) await this.load();
      const result = await mutator(this.data);
      await this.#flush();
      return result;
    });
    // 无论成功失败都放行后续任务，避免一次异常锁死整条链。
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async #flush() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}
