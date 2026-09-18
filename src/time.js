// 统一的时间工具：邀请按绝对时间（epoch 毫秒）判断，
// 课程时段在对外展示时保留学校所在地的明确时区偏移量。

export function toEpoch(value, field = 'time') {
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isNaN(t)) throw new Error(`${field} 不是有效时间`);
    return t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isNaN(t)) throw new Error(`${field} 不是有效时间: ${value}`);
    return t;
  }
  throw new Error(`${field} 不是有效时间`);
}

export function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function describeOffset(epoch, offsetMinutes) {
  // offsetMinutes 为学校相对 UTC 的偏移（东八区为 +480）。
  const shifted = new Date(epoch + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} ` +
    `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
