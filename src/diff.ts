import type { DiffRow } from "./types";

/** diff 展示上限：行数太多时截断，避免动态规划把界面卡死 */
const MAX_ROWS = 800;

/**
 * 行级 LCS diff。超过行数上限时退化为「整块删 + 整块加」。
 */
export function diffLines(oldText: string, newText: string): { rows: DiffRow[]; truncated: boolean } {
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");
  const truncated = oldLines.length > MAX_ROWS || newLines.length > MAX_ROWS;

  if (truncated) {
    const rows: DiffRow[] = [];
    let oldNo = 0;
    let newNo = 0;
    for (const line of oldLines) rows.push({ type: "del", text: line, oldNo: ++oldNo });
    for (const line of newLines) rows.push({ type: "add", text: line, newNo: ++newNo });
    return { rows, truncated: true };
  }

  const n = oldLines.length;
  const m = newLines.length;
  // LCS 长度表：(n+1) × (m+1)，按行用 Int32Array 存储
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (row: number, col: number) => row * (m + 1) + col;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        oldLines[i] === newLines[j]
          ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 0;
  let newNo = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "same", text: oldLines[i], oldNo: ++oldNo, newNo: ++newNo });
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      rows.push({ type: "del", text: oldLines[i], oldNo: ++oldNo });
      i++;
    } else {
      rows.push({ type: "add", text: newLines[j], newNo: ++newNo });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: oldLines[i], oldNo: ++oldNo }), i++;
  while (j < m) rows.push({ type: "add", text: newLines[j], newNo: ++newNo }), j++;
  return { rows, truncated: false };
}
