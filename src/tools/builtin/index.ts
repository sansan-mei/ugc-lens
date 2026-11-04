import type { AgentTool } from '../types.ts'
import { createReadFileTool, type ReadFileOptions } from './read_file.ts'
import { createRunCommandTool, type RunCommandOptions } from './run_command.ts'
import { createWriteFileTool } from './write_file.ts'

export { isReadOnlyCommand } from './command_policy.ts'
export { createReadFileTool, createRunCommandTool, createWriteFileTool }

export interface BuiltinToolOptions {
  readFile?: ReadFileOptions
  runCommand?: RunCommandOptions
}

export function createBuiltinTools(options: BuiltinToolOptions = {}): AgentTool[] {
  return [createReadFileTool(options.readFile), createWriteFileTool(), createRunCommandTool(options.runCommand)]
}
