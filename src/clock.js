// 时钟抽象：生产环境用真实时钟，测试用可手动推进的假时钟。
// 所有有效期判断都以绝对时间（epoch 毫秒）为准，不依赖进程存活期间的定时器。

export class RealClock {
  now() {
    return Date.now();
  }

  scheduleAt(atEpochMs, fn) {
    const delay = Math.max(0, atEpochMs - Date.now());
    return setTimeout(fn, delay);
  }

  cancel(handle) {
    clearTimeout(handle);
  }
}

export class FakeClock {
  constructor(startEpochMs) {
    this._now = startEpochMs;
    this._jobs = new Map();
    this._seq = 0;
  }

  now() {
    return this._now;
  }

  scheduleAt(atEpochMs, fn) {
    const id = ++this._seq;
    this._jobs.set(id, { at: atEpochMs, seq: id, fn });
    return id;
  }

  cancel(handle) {
    this._jobs.delete(handle);
  }

  // 把时钟向前推进 ms 毫秒，并按到期顺序执行期间排定的回调；回调允许继续排定新任务
  async advance(ms) {
    const target = this._now + ms;
    for (;;) {
      const due = [...this._jobs.values()]
        .filter((j) => j.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (due.length === 0) break;
      const job = due[0];
      this._jobs.delete(job.seq);
      this._now = job.at;
      await job.fn();
    }
    this._now = target;
  }
}
