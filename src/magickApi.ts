import * as StackTrace from 'stacktrace-js'

// Worker loading

interface CallPromise extends Promise<CallResult> {
  resolve?: (CallResult) => void, reject?: any
  command: CallCommand
  files: MagickInputFile[]
}

enum WorkerMessageType {
  'stderr',
  'stdout',
  'result',
  'call',
}
interface WorkerMessage {
  type: WorkerMessageType
}

/** message posted from the client to the worker requesting a command call */
interface CommandCallClientRequest extends WorkerMessage {
  type: WorkerMessageType.call
  command: CallCommand
  files: MagickInputFile[]
  requestNumber: number
}

/** message posted form the worker to the client notifying a command call has ended.  */
interface WorkerResultMessage extends WorkerMessage, CallResult {
  type: WorkerMessageType.result
  requestNumber: number
}

/** message posted from the worker globally each time stdout or stderr command have new content */
interface WorkerStdioMessage extends WorkerMessage {
  text: string
}

function isWorkerStdioMessage(m: any): m is WorkerStdioMessage {
  return (m.type === WorkerMessageType.stdout || m.type === WorkerMessageType.stderr) && typeof m.text !== 'undefined'
}

function isWorkerResultMessage(m: any): m is WorkerResultMessage {
  return m.type === WorkerMessageType.result
}

function createCallPromise(): CallPromise {
  let resolver
  const promise = new Promise(resolve => resolver = resolve) as CallPromise
  promise.resolve = resolver
  return promise
}

function changeUrlFileName(url, fileName) {
  const splitUrl = url.split('/')
  splitUrl[splitUrl.length - 1] = fileName
  return splitUrl.join('/')
}

// Heads up : instead of doing the sane code of being able to just use import.meta.url
// (Edge doesn't work) (safari mobile, chrome, opera, firefox all do) . We use stacktrace-js library to get the current file name
//
// try {
//   // @ts-ignore
//   let packageUrl = import.meta.url
//   currentJavascriptURL = packageUrl
// } catch (error) {
//   // eat
// }
let _currentJsUrl: string
/** gets the url of the current .js file loaded by the browser */
function getCurrentJsUrl(): string {
  if (!_currentJsUrl) {
    const stacktrace = StackTrace.getSync()
    _currentJsUrl = stacktrace && stacktrace[0] && stacktrace[0].fileName || './magickApi.js'
  }
  return _currentJsUrl
}

function createWorker() {
  const currentJavascriptURL = getCurrentJsUrl()
  const magickWorkerUrl = changeUrlFileName(currentJavascriptURL, 'magick.js')
  let worker: Worker
  if (currentJavascriptURL.startsWith('http')) {
    worker = new Worker(window.URL.createObjectURL(new Blob([`
// global variable read by webworker to see if there is a custom path
magickJsCurrentPath = '${magickWorkerUrl}'
importScripts(magickJsCurrentPath)
`])))
  }
  else {
    worker = new Worker(magickWorkerUrl)
  }
  // handle responses as they stream in after being outputFiles by image magick
  worker.onmessage = e => {
    const response = e.data as WorkerMessage
    if (isWorkerResultMessage(response)) {
      const promise = magickWorkerPromises[response.requestNumber]
      delete magickWorkerPromises[response.requestNumber]
      const result: CallResult = {
        outputFiles: response.outputFiles,
        stdout: response.stdout,
        stderr: response.stderr,
        exitCode: response.exitCode || 0,
        command: promise.command,
        files: promise.files,
      }
      promise.resolve(result)
    }
    else if (isWorkerStdioMessage(response)) {
      callListeners.forEach(l => {
        if (response.type === WorkerMessageType.stderr && l.onStderr) {
          l.onStderr(response.text)
        }
        else if (response.type === WorkerMessageType.stdout && l.onStdout) {
          l.onStdout(response.text)
        }
      })
    }
    else {
      throw new Error(`Message type ${response.type} unknown from web worker`)
    }
  }
  return worker
}

const magickWorkerPromises: { [key: number]: CallPromise } = {}

let magickWorkerPromisesKey = 1

const magickWorker = createWorker()

// ImageMagick core types

/**
 * Base class for ImageMagick input and output files.
 */
export interface MagickFile {
  name: string
  /** Internal flag so some commands (virtual) can flag an (output) to be ignored by manager / UI */
  ignore?: boolean
}

/**
 * Represents output files generated when an ImageMagick command executes.
 */
export interface MagickOutputFile extends MagickFile {
  blob: Blob
}

/**
 * Represents input files that need to be provided to {@link call} or [execute](https://github.com/KnicKnic/WASM-ImageMagick/tree/master/apidocs#execute).
 *
 * Can be builded using {@link buildInputFile}
 */
export interface MagickInputFile extends MagickFile {
  content: Uint8Array
}

/**
 * The result of calling {@link call}. Also the base class of results of calling [execute](https://github.com/KnicKnic/WASM-ImageMagick/tree/master/apidocs#execute).
 */
export interface CallResult {
  /**
   * Output files generated by the command, if any
   */
  outputFiles: MagickOutputFile[]
  /**
   * Output printed by the command to stdout. For example the command `identify rose:` will print useful information to stdout
   */
  stdout: string[]
  /**
   * Output printed by the command to stderr. If `exitCode != 0` then this property could have some information about the error.
   */
  stderr: string[]
  /**
   * Exit code of the command executed. If 0 the command executed successfully, otherwise an error occurred and `stderr` could have some information about what was wrong
   */
  exitCode: number

  /** the command used for this result */
  command: CallCommand,

  /** the input files used for this result */
  files: MagickInputFile[]
}

export type CallCommand = string[]

// call() main operation
/**
 * Low level, core, IM command execution function. All the other functions like [execute](https://github.com/KnicKnic/WASM-ImageMagick/tree/master/apidocs#execute)
 * ends up calling this one. It accept only one command and only in the form of array of strings.
 */
export function call(files: MagickInputFile[], command: CallCommand): Promise<CallResult> {
  const request: CommandCallClientRequest = {
    files,
    type: WorkerMessageType.call,
    command,
    requestNumber: magickWorkerPromisesKey,
  }
  const promise = createCallPromise();
  (promise as any).command = command;
  (promise as any).files = files
  magickWorkerPromises[magickWorkerPromisesKey] = promise

  const t0 = performance.now()
  const id = magickWorkerPromisesKey
  callListeners.forEach(listener => {
    if (listener.beforeCall) {
      listener.beforeCall({ files, command, id })
    }
  })

  promise.then(async callResult => {
    const took = performance.now() - t0
    callListeners.forEach(listener => {
      if (listener.afterCall) {
        listener.afterCall({ files, command, id, callResult, took })
      }
    })
    return callResult
  })

  magickWorker.postMessage(request)
  magickWorkerPromisesKey++

  return promise
}

/**
 * {@link call} shortcut that only returns the output files.
 */
export async function Call(inputFiles: MagickInputFile[], command: string[]): Promise<MagickOutputFile[]> {
  const result = await call(inputFiles, command)
  return result.outputFiles
}

// call() global event emitter

export interface CallEvent {
  command: string[]
  files: MagickInputFile[]
  callResult?: CallResult
  took?: number
  id: number
}

export interface CallListener {
  afterCall?(event: CallEvent): void
  beforeCall?(event: CallEvent): void
  onStdout?(text: string): void
  onStderr?(text: string): void
}

const callListeners: CallListener[] = []

/**
 * Register a global `call()` listener that will be notified on any command call and when any stdout/stderr occurs
 */
export function addCallListener(l: CallListener) {
  callListeners.push(l)
}

export function removeAllCallListeners() {
  callListeners.splice(0, callListeners.length)
}

// TODO: removeCallListener
