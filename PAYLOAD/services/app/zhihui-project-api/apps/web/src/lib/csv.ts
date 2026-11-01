/** Export the currently visible, real API-backed rows as UTF-8 CSV. */
export function csvCell(value: unknown) {
  const text = value == null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const content = '\ufeff' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
