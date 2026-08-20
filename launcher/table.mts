export const STATUS_LABELS: Readonly<Record<string, string>> = {
  online: "실행 중",
  launching: "시작 중",
  stopping: "중지 중",
  stopped: "중지됨",
  errored: "오류",
  "waiting restart": "재시작 대기 중",
}

const FULL_WIDTH_CHARACTER =
  /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

const displayWidth = (value: string): number =>
  Array.from(value).reduce(
    (width, character) => width + (FULL_WIDTH_CHARACTER.test(character) ? 2 : 1),
    0,
  )

const padToWidth = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`

export const printTable = (rows: string[][]): void => {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => displayWidth(row[column] ?? ""))),
  )
  if (widths === undefined) return
  for (const row of rows) {
    console.log(
      row
        .map((value, column) => padToWidth(value, widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
  }
}
