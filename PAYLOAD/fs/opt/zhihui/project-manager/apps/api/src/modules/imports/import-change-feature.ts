const disabledValues = new Set(['0', 'false', 'off', 'disabled'])

export function importChangeTrackingEnabled(value = process.env.IMPORT_CHANGE_TRACKING_ENABLED) {
  return value === undefined || !disabledValues.has(value.trim().toLowerCase())
}

export function requireImportChangeTrackingEnabled(value = process.env.IMPORT_CHANGE_TRACKING_ENABLED) {
  if (!importChangeTrackingEnabled(value)) throw new Error('import_change_tracking_disabled')
}
