import { applyCredentialsFile } from './credentials-file'

export const CREDENTIALS_FROM_FILE = applyCredentialsFile()

export function credentialsFromFileSummary(): string {
  const fields = Object.keys(CREDENTIALS_FROM_FILE)
  return fields.length === 0 ? 'nothing (config.json absent or blank)' : fields.join(', ')
}
