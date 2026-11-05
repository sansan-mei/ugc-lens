export type ImportErrorCode = 'read_failed' | 'too_large' | 'not_json' | 'not_jsonl' | 'not_csv' | 'empty_data' | 'unsupported_format' | 'invalid_encoding' | 'not_feedback' | 'no_model' | 'inference_failed'

export class ImportError extends Error {
  override name = 'ImportError'
  readonly code: ImportErrorCode
  constructor(code: ImportErrorCode, message: string) {
    super(message)
    this.code = code
  }
}
export const MAX_FILE_BYTES = 100 * 1024 * 1024
