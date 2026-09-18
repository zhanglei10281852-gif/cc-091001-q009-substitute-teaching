import { resolve } from 'node:path';
import { SubstituteEngine } from './engine.js';
import { Store } from './store.js';
import { RealClock } from './clock.js';
import { createApp } from './http.js';
import { loadTeachers } from './teachers.js';

// 启动入口：SUBSTITUTE_DATA_FILE 持久化日志、SUBSTITUTE_TEACHERS_FILE 当日教师资料、
// PORT 监听端口（默认 3000）、TZ_OFFSET_MINUTES 学校所在地偏移量（默认 +08:00）
export async function createContext(env = process.env) {
  const dataFile = env.SUBSTITUTE_DATA_FILE
    ? resolve(env.SUBSTITUTE_DATA_FILE)
    : resolve(process.cwd(), 'data/substitute.jsonl');
  const store = new Store(dataFile);
  const clock = new RealClock();
  const teachers = env.SUBSTITUTE_TEACHERS_FILE ? await loadTeachers(resolve(env.SUBSTITUTE_TEACHERS_FILE)) : [];
  const engine = new SubstituteEngine({
    store,
    clock,
    teachers,
    tzOffsetMinutes: env.TZ_OFFSET_MINUTES ? Number(env.TZ_OFFSET_MINUTES) : 8 * 60,
  });
  await engine.start();
  return { store, clock, engine };
}

export async function startServer() {
  const ctx = await createContext();
  const app = createApp(ctx.engine);
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`代课接续服务已启动，端口 ${port}`);
  });

  const shutdown = async (signal) => {
    console.log(`收到 ${signal}，正在关闭…`);
    app.close();
    await ctx.store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return { ...ctx, app };
}

// 直接执行（node src/server.js）时启动服务；被 import 时不自动启动
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error('服务启动失败:', err);
    process.exit(1);
  });
}
