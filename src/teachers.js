// 教师资料加载：真实课表与联系信息由运行环境提供。
// 默认从环境变量 SUBSTITUTE_TEACHERS_FILE 指定的 JSON 文件读取，
// 文件结构：[{ id, name, subjects: ["chinese"], dailyMax: 6, consecutiveMax: 4,
//   schedule: [{ classRef, startsAt, endsAt }] }]
import { readFile } from 'node:fs/promises';

export async function loadTeachers(filePath) {
  const text = await readFile(filePath, 'utf8');
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('教师资料文件必须是数组');
  return data;
}
