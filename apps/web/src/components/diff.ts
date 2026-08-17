export interface DiffLine {
  kind: "same" | "added" | "removed";
  value: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(columns).fill(0));

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const row = table[leftIndex];
      if (!row) continue;
      row[rightIndex] = left[leftIndex] === right[rightIndex]
        ? (table[leftIndex + 1]?.[rightIndex + 1] ?? 0) + 1
        : Math.max(table[leftIndex + 1]?.[rightIndex] ?? 0, table[leftIndex]?.[rightIndex + 1] ?? 0);
    }
  }

  const result: DiffLine[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      result.push({ kind: "same", value: left[leftIndex] ?? "" });
      leftIndex += 1;
      rightIndex += 1;
    } else if ((table[leftIndex + 1]?.[rightIndex] ?? 0) >= (table[leftIndex]?.[rightIndex + 1] ?? 0)) {
      result.push({ kind: "removed", value: left[leftIndex] ?? "" });
      leftIndex += 1;
    } else {
      result.push({ kind: "added", value: right[rightIndex] ?? "" });
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) result.push({ kind: "removed", value: left[leftIndex++] ?? "" });
  while (rightIndex < right.length) result.push({ kind: "added", value: right[rightIndex++] ?? "" });
  return result;
}
