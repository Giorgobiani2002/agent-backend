export function toPgVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

