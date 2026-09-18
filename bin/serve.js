// 服务入口：node bin/serve.js [dataFile]
// 启动时先 reconcile：未过期占位保留，过期项立即清理。
import { resolve } from 'node:path';
import { JsonStore } from '../src/store.js';
import { SchedulerEngine } from '../src/engine.js';
import { createServer } from '../src/server.js';

const dataFile = resolve(process.argv[2] ?? process.env.DATA_FILE ?? 'data/state.json');
const store = new JsonStore(dataFile);
await store.load();
const engine = new SchedulerEngine(store, {
  defaultResponseSeconds: Number(process.env.RESPONSE_SECONDS ?? 300),
  defaultOffsetMinutes: Number(process.env.SCHOOL_OFFSET_MINUTES ?? 480),
});
const result = await engine.reconcile();
const server = createServer(engine);
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(JSON.stringify({ listening: port, dataFile, ...result }));
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
