// 极简日志：Build 阶段输出带前缀的行，方便阅读

export type LogLevel = "info" | "warn" | "error" | "debug";

export function log(msg: string): void {
  console.log(msg);
}

export function info(msg: string): void {
  console.log(msg);
}

export function warn(msg: string): void {
  console.log(`[warn] ${msg}`);
}

export function error(msg: string): void {
  console.error(`[error] ${msg}`);
}

export function section(title: string): void {
  console.log("");
  console.log(`== ${title} ==`);
}