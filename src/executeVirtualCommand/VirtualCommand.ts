import { ExecuteResult } from '../execute'
import { MagickInputFile } from '../magickApi'
import { values } from '../util'
import buildInputFile from './buildInputFile'
import cat from './cat'
import ls from './ls'
import uniqueName from './uniqueName'
import substitution from './substitution'
import variableDeclaration from './variableDeclaration'
import variableSubstitution from './variableSubstitution';

export interface VirtualCommand {
  name: string
  execute(c: VirtualCommandContext): Promise<ExecuteResult>
  predicate(c: VirtualCommandContext): boolean
}

export type VirtualCommandLogs = {[virtualCommandName: string]: any[]}
export interface VirtualCommandContext {
  command: string[]
  files: { [name: string]: MagickInputFile }
  executionId: number
  virtualCommandLogs:  VirtualCommandLogs
}

const virtualCommands: VirtualCommand[] = []

export function isVirtualCommand(context: VirtualCommandContext): boolean {
  return !!virtualCommands.find(c => c.predicate(context))
}

export function _dispatchVirtualCommand(context: VirtualCommandContext): Promise<ExecuteResult> {
  const cmd = virtualCommands.find(c => c.predicate(context))
  context.virtualCommandLogs[cmd.name] = context.virtualCommandLogs[cmd.name] ||[]
  return cmd.execute(context)
}

export function registerExecuteVirtualCommand(c: VirtualCommand) {
  virtualCommands.push(c)
}

// registerExecuteVirtualCommand(variableSubstitution)
registerExecuteVirtualCommand(substitution)
// registerExecuteVirtualCommand(variableDeclaration)

registerExecuteVirtualCommand(ls)

registerExecuteVirtualCommand(cat)

registerExecuteVirtualCommand(buildInputFile)

registerExecuteVirtualCommand(uniqueName)

export function _newExecuteResult(c: VirtualCommandContext, result: Partial<ExecuteResult> = {}): ExecuteResult {
  const r: ExecuteResult = {
    ...{
      outputFiles: [],
      commands: [c.command],
      command: c.command,
      exitCode: 0,
      stderr: [], stdout: [],
      inputFiles: values(c.files), 
      results: []
    }, ...result,
  }
  return { ...r, results: [r] }
}