export interface DiffLine {
  kind: "same" | "added" | "removed";
  value: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  if ((left.length + 1) * (right.length + 1) > 250_000) {
    return boundedDiff(left, right);
  }
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

function boundedDiff(left: string[], right: string[]): DiffLine[] {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return [
    ...left.slice(0, prefix).map((value): DiffLine => ({ kind: "same", value })),
    ...left.slice(prefix, left.length - suffix).map((value): DiffLine => ({ kind: "removed", value })),
    ...right.slice(prefix, right.length - suffix).map((value): DiffLine => ({ kind: "added", value })),
    ...left.slice(left.length - suffix).map((value): DiffLine => ({ kind: "same", value })),
  ];
}
