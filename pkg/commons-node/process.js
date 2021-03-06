/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 */

import type {ProcessExitMessage, ProcessMessage, ProcessInfo} from './process-rpc-types';

import {observableFromSubscribeFunction} from '../commons-node/event';
import child_process from 'child_process';
import {MultiMap} from './collection';
import nuclideUri from './nuclideUri';
import {splitStream, takeWhileInclusive} from './observable';
import {observeStream} from './stream';
import {maybeToString} from './string';
import {Observable} from 'rxjs';
import invariant from 'assert';
import {quote} from 'shell-quote';
import performanceNow from './performanceNow';
import idx from 'idx';

// TODO(T17266325): Replace this in favor of `atom.whenShellEnvironmentLoaded()` when it lands
import atomWhenShellEnvironmentLoaded from './whenShellEnvironmentLoaded';

// Node crashes if we allow buffers that are too large.
const DEFAULT_MAX_BUFFER = 100 * 1024 * 1024;

const MAX_LOGGED_CALLS = 100;
const PREVERVED_HISTORY_CALLS = 50;

const noopDisposable = {dispose: () => {}};
const whenShellEnvironmentLoaded =
  typeof atom !== 'undefined' && atomWhenShellEnvironmentLoaded && !atom.inSpecMode()
    ? atomWhenShellEnvironmentLoaded
    : cb => { cb(); return noopDisposable; };

export const loggedCalls = [];
function logCall(duration, command, args) {
  // Trim the history once in a while, to avoid doing expensive array
  // manipulation all the time after we reached the end of the history
  if (loggedCalls.length > MAX_LOGGED_CALLS) {
    loggedCalls.splice(
      0,
      loggedCalls.length - PREVERVED_HISTORY_CALLS,
      {time: new Date(), duration: 0, command: '... history stripped ...'},
    );
  }
  loggedCalls.push({
    duration,
    command: [command, ...args].join(' '),
    time: new Date(),
  });
}

export type AsyncExecuteReturn = {
  // If the process fails to even start up, exitCode will not be set
  // and errorCode / errorMessage will contain the actual error message.
  // Otherwise, exitCode will always be defined.
  errorMessage?: string,
  errorCode?: string,
  exitCode?: number,
  stderr: string,
  stdout: string,
};

type CreateProcessStreamOptions = {
  killTreeOnComplete?: ?boolean,
  exitErrorBufferSize?: ?number,
  isExitError?: ?(event: ProcessExitMessage) => boolean,
};

type GetOutputStreamOptions = {
  splitByLines?: ?boolean,
};

export type ObserveProcessOptions = SpawnProcessOptions
  & CreateProcessStreamOptions
  & GetOutputStreamOptions;

export type SpawnProcessOptions = child_process$spawnOpts & CreateProcessStreamOptions;
export type ForkProcessOptions = child_process$forkOpts & CreateProcessStreamOptions;

/**
 * An error thrown by process utils when the process exits with an error code. This type should have
 * all the properties of ProcessExitMessage (except "kind").
 */
export class ProcessExitError extends Error {
  exitCode: ?number;
  signal: ?string;
  stderr: string;
  process: child_process$ChildProcess;

  constructor(exitMessage: ProcessExitMessage, proc: child_process$ChildProcess, stderr: string) {
    // $FlowIssue: This isn't typed in the Flow node type defs
    const {spawnargs} = proc;
    const commandName = spawnargs[0] === process.execPath ? spawnargs[1] : spawnargs[0];
    super(
      `"${commandName}" failed with ${exitEventToMessage(exitMessage)}\n\n${stderr}`,
    );
    this.name = 'ProcessExitError';
    this.exitCode = exitMessage.exitCode;
    this.signal = exitMessage.signal;
    this.stderr = stderr;
    this.process = proc;
  }
}

// Copied from https://github.com/facebook/flow/blob/v0.43.1/lib/node.js#L11-L16
type ErrnoError = {
  errno?: number,
  code?: string,
  path?: string,
  syscall?: string,
};

export type ProcessError = ErrnoError | ProcessExitError;

export type AsyncExecuteOptions = child_process$execFileOpts & {
  // The contents to write to stdin.
  stdin?: ?string,
  dontLogInNuclide?: ?boolean,
};

const STREAM_NAMES = ['stdin', 'stdout', 'stderr'];

function logError(...args) {
  // Can't use nuclide-logging here to not cause cycle dependency.
  // eslint-disable-next-line no-console
  console.error(...args);
}

function log(...args) {
  // Can't use nuclide-logging here to not cause cycle dependency.
  // eslint-disable-next-line no-console
  console.log(...args);
}

function monitorStreamErrors(process: child_process$ChildProcess, command, args, options): void {
  STREAM_NAMES.forEach(streamName => {
    // $FlowIssue
    const stream = process[streamName];
    if (stream == null) {
      return;
    }
    stream.on('error', error => {
      // This can happen without the full execution of the command to fail,
      // but we want to learn about it.
      logError(
        `stream error on stream ${streamName} with command:`,
        command,
        args,
        options,
        'error:',
        error,
      );
    });
  });
}

/**
 * Helper type/function to create child_process by spawning/forking the process.
 */
type ChildProcessOpts = child_process$spawnOpts | child_process$forkOpts;

function _makeChildProcess(
  type: 'spawn' | 'fork' = 'spawn',
  command: string,
  args?: Array<string> = [],
  options?: ChildProcessOpts = {},
): child_process$ChildProcess {
  const now = performanceNow();
  // $FlowFixMe: child_process$spawnOpts and child_process$forkOpts have incompatable stdio types.
  const child = child_process[type](nuclideUri.expandHomeDir(command), args, {...options});
  monitorStreamErrors(child, command, args, options);
  child.on('error', error => {
    logError('error with command:', command, args, options, 'error:', error);
  });
  if (!options || !options.dontLogInNuclide) {
    child.on('close', () => {
      logCall(Math.round(performanceNow() - now), command, args);
    });
  }
  writeToStdin(child, options);
  return child;
}

/**
 * Takes the command and args that you would normally pass to `spawn()` and returns `newArgs` such
 * that you should call it with `spawn('script', newArgs)` to run the original command/args pair
 * under `script`.
 */
export function createArgsForScriptCommand(
  command: string,
  args?: Array<string> = [],
): Array<string> {
  if (process.platform === 'darwin') {
    // On OS X, script takes the program to run and its arguments as varargs at the end.
    return ['-q', '/dev/null', command].concat(args);
  } else {
    // On Linux, script takes the command to run as the -c parameter.
    const allArgs = [command].concat(args);
    return ['-q', '/dev/null', '-c', quote(allArgs)];
  }
}

/**
 * Creates an observable with the following properties:
 *
 * 1. It contains a process that's created using the provided factory when you subscribe.
 * 2. It doesn't complete until the process exits (or errors).
 * 3. The process is killed when you unsubscribe.
 *
 * This means that a single observable instance can be used to spawn multiple processes. Indeed, if
 * you subscribe multiple times, multiple processes *will* be spawned.
 *
 * IMPORTANT: The exit event does NOT mean that all stdout and stderr events have been received.
 */
function _createProcessStream(
  createProcess: () => child_process$ChildProcess,
  options: CreateProcessStreamOptions = {},
): Observable<child_process$ChildProcess> {
  return observableFromSubscribeFunction(whenShellEnvironmentLoaded)
    .take(1)
    .switchMap(() => {
      const process = createProcess();
      const isExitError = idx(options, _ => _.isExitError) || isExitErrorDefault;
      const exitErrorBufferSize = idx(options, _ => _.exitErrorBufferSize) || 2000;
      const {killTreeOnComplete} = options;
      let finished = false;

      // If the process returned by `createProcess()` was not created by it (or at least in the same
      // tick), it's possible that its error event has already been dispatched. This is a bug that
      // needs to be fixed in the caller. Generally, that would just mean refactoring your code to
      // create the process in the function you pass. If for some reason, this is absolutely not
      // possible, you need to make sure that the process is passed here immediately after it's
      // created (i.e. before an ENOENT error event would be dispatched). Don't refactor your code
      // to avoid this function; you'll have the same bug, you just won't be notified! XD
      invariant(
        process.exitCode == null && !process.killed,
        'Process already exited. (This indicates a race condition in Nuclide.)',
      );

      const errors = Observable.fromEvent(process, 'error').flatMap(Observable.throw);

      // Accumulate the first `exitErrorBufferSize` bytes of stderr so that we can give feedback
      // about exit errors. Once we have this much, we don't even listen to the event anymore.
      const accumulatedStderr = takeWhileInclusive(
        observeStream(process.stderr)
          .scan((acc, stderrData) => (acc + stderrData).slice(0, exitErrorBufferSize), '')
          .startWith(''),
        acc => acc.length < exitErrorBufferSize,
      );

      const exitEvents = observeProcessExitMessage(process)
        .withLatestFrom(accumulatedStderr)
        .map(([rawEvent, stderr]) => {
          const event = {...rawEvent, stderr};
          if (isExitError(event)) {
            throw new ProcessExitError(event, process, stderr);
          }
          return event;
        });

      return Observable.of(process)
        // Don't complete until we say so!
        .merge(Observable.never())
        .takeUntil(errors)
        .takeUntil(exitEvents)
        .do({
          error: () => { finished = true; },
          complete: () => { finished = true; },
        })
        .finally(() => {
          if (!process.wasKilled && !finished) {
            killProcess(process, Boolean(killTreeOnComplete));
          }
        });
    });
}

export function killProcess(
  childProcess: child_process$ChildProcess,
  killTree: boolean,
): void {
  log(`Ending process stream. Killing process ${childProcess.pid}`);
  _killProcess(childProcess, killTree).then(
    () => {},
    error => {
      logError(`Killing process ${childProcess.pid} failed`, error);
    },
  );
}

async function _killProcess(
  childProcess: child_process$ChildProcess & {wasKilled?: boolean},
  killTree: boolean,
): Promise<void> {
  childProcess.wasKilled = true;
  if (!killTree) {
    childProcess.kill();
    return;
  }
  if (/^win/.test(process.platform)) {
    await killWindowsProcessTree(childProcess.pid);
  } else {
    await killUnixProcessTree(childProcess);
  }
}

function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    child_process.exec(`taskkill /pid ${pid} /T /F`, error => {
      if (error == null) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch (err) {
    if (err.code !== 'ESRCH') {
      throw err;
    }
  }
}

export async function killUnixProcessTree(childProcess: child_process$ChildProcess): Promise<void> {
  const descendants = await getDescendantsOfProcess(childProcess.pid);
  // Kill the processes, starting with those of greatest depth.
  for (const info of descendants.reverse()) {
    killPid(info.pid);
  }
}

export function spawn(
  command: string,
  args?: Array<string>,
  options?: SpawnProcessOptions,
): Observable<child_process$ChildProcess> {
  return _createProcessStream(
    () => _makeChildProcess('spawn', command, args, options),
    options,
  );
}

export function fork(
  modulePath: string,
  args?: Array<string>,
  options?: ForkProcessOptions,
): Observable<child_process$ChildProcess> {
  return _createProcessStream(
    () => _makeChildProcess('fork', modulePath, args, options),
    {...options},
  );
}

function observeProcessExitMessage(
  process: child_process$ChildProcess,
): Observable<ProcessExitMessage> {
  return Observable.fromEvent(
      process,
      'exit',
      (exitCode: ?number, signal: ?string) => ({kind: 'exit', exitCode, signal}))
    // An exit signal from SIGUSR1 doesn't actually exit the process, so skip that.
    .filter(message => message.signal !== 'SIGUSR1')
    .take(1);
}

function isExitErrorDefault(exit: ProcessExitMessage): boolean {
  return exit.exitCode !== 0;
}

/**
 * Creates a stream of sensibly-ordered stdout, stdin, and exit messages from a process. Generally,
 * you shouldn't use this function and should instead use `observeProcess()` (which makes use of
 * this for you).
 *
 * IMPORTANT: If you must use this message, it's very important that the process you give it was
 * just synchronously created. Otherwise, you can end up missing messages.
 *
 * This function intentionally does not close the process when you unsubscribe. It's usually used in
 * conjunction with `spawn()` which does that already.
 */
export function getOutputStream(
  process: child_process$ChildProcess,
  options?: GetOutputStreamOptions,
  rest: void,
): Observable<ProcessMessage> {
  const chunk = idx(options, _ => _.splitByLines) === false ? (x => x) : splitStream;
  return Observable.defer(() => {
    const stdoutEvents = chunk(observeStream(process.stdout)).map(data => ({kind: 'stdout', data}));
    const stderrEvents = chunk(observeStream(process.stderr)).map(data => ({kind: 'stderr', data}));

    // We need to start listening for the exit event immediately, but defer emitting it until the
    // (buffered) output streams end.
    const exitEvents = observeProcessExitMessage(process).publishReplay();
    const exitSub = exitEvents.connect();

    // It's possible for stdout and stderr to remain open (even indefinitely) after the exit event.
    // This utility, however, treats the exit event as stream-ending, which helps us to avoid easy
    // bugs. We give a short (100ms) timeout for the stdout and stderr streams to close.
    const close = exitEvents.delay(100);

    return takeWhileInclusive(
      Observable.merge(stdoutEvents, stderrEvents).takeUntil(close).concat(exitEvents),
      event => event.kind !== 'error' && event.kind !== 'exit',
    )
      .finally(() => { exitSub.unsubscribe(); });
  });
}

/**
 * Observe the stdout, stderr and exit code of a process.
 */
export function observeProcess(
  command: string,
  args?: Array<string>,
  options?: ObserveProcessOptions,
): Observable<ProcessMessage> {
  return _createProcessStream(
    () => _makeChildProcess('spawn', command, args, options),
    options,
  )
    .flatMap(process => getOutputStream(process, options));
}

/**
 * Observe the stdout, stderr and exit code of a process.
 */
export function observeProcessRaw(
  command: string,
  args?: Array<string>,
  options?: ObserveProcessOptions,
): Observable<ProcessMessage> {
  return _createProcessStream(
    () => _makeChildProcess('spawn', command, args, options),
    options,
  )
    .flatMap(process => getOutputStream(process, {...options, splitByLines: false}));
}

/**
 * Returns a promise that resolves to the result of executing a process.
 *
 * @param command The command to execute.
 * @param args The arguments to pass to the command.
 * @param options Options for changing how to run the command.
 *     Supports the options listed here: http://nodejs.org/api/child_process.html
 *     in addition to the custom options listed in AsyncExecuteOptions.
 */
export async function asyncExecute(
  command: string,
  args: Array<string>,
  options?: AsyncExecuteOptions = {},
): Promise<AsyncExecuteReturn> {
  const now = performanceNow();
  await new Promise(resolve => whenShellEnvironmentLoaded(resolve));
  return new Promise((resolve, reject) => {
    const process = child_process.execFile(
      nuclideUri.expandHomeDir(command),
      args,
      {maxBuffer: DEFAULT_MAX_BUFFER, ...options},
      // Node embeds various properties like code/errno in the Error object.
      (err: any /* Error */, stdoutBuf, stderrBuf) => {
        if (!options || !options.dontLogInNuclide) {
          logCall(Math.round(performanceNow() - now), command, args);
        }
        const stdout = stdoutBuf.toString('utf8');
        const stderr = stderrBuf.toString('utf8');
        if (err == null) {
          resolve({
            stdout,
            stderr,
            exitCode: 0,
          });
        } else if (Number.isInteger(err.code)) {
          resolve({
            stdout,
            stderr,
            exitCode: err.code,
          });
        } else {
          resolve({
            stdout,
            stderr,
            errorCode: err.errno || 'EUNKNOWN',
            errorMessage: err.message,
          });
        }
      },
    );
    writeToStdin(process, options);
  });
}

function writeToStdin(
  childProcess: child_process$ChildProcess,
  options: Object,
): void {
  if (typeof options.stdin === 'string' && childProcess.stdin != null) {
    // Note that the Node docs have this scary warning about stdin.end() on
    // http://nodejs.org/api/child_process.html#child_process_child_stdin:
    //
    // "A Writable Stream that represents the child process's stdin. Closing
    // this stream via end() often causes the child process to terminate."
    //
    // In practice, this has not appeared to cause any issues thus far.
    childProcess.stdin.write(options.stdin);
    childProcess.stdin.end();
  }
}

/**
 * Simple wrapper around asyncExecute that throws if the exitCode is non-zero.
 */
export async function checkOutput(
  command: string,
  args: Array<string>,
  options?: AsyncExecuteOptions = {},
): Promise<AsyncExecuteReturn> {
  const result = await asyncExecute(nuclideUri.expandHomeDir(command), args, options);
  if (result.exitCode !== 0) {
    const reason = result.exitCode != null ? `exitCode: ${result.exitCode}` :
      `error: ${maybeToString(result.errorMessage)}`;
    throw new Error(
      `asyncExecute "${command}" failed with ${reason}, ` +
      `stderr: ${result.stderr}, stdout: ${result.stdout}.`,
    );
  }
  return result;
}

/**
 * Run a command, accumulate the output. Errors are surfaced as stream errors and unsubscribing will
 * kill the process.
 */
export function runCommand(
  command: string,
  args?: Array<string> = [],
  options?: ObserveProcessOptions = {},
  rest: void,
): Observable<string> {
  return observeProcess(command, args, options)
    .filter(event => event.kind === 'stdout')
    .reduce(
      (acc, event) => {
        invariant(event.kind === 'stdout');
        return acc + event.data;
      },
      '',
    );
}

// If provided, read the original environment from NUCLIDE_ORIGINAL_ENV.
// This should contain the base64-encoded output of `env -0`.
let cachedOriginalEnvironment = null;
export async function getOriginalEnvironment(): Promise<Object> {
  await new Promise(resolve => { whenShellEnvironmentLoaded(resolve); });
  if (cachedOriginalEnvironment != null) {
    return cachedOriginalEnvironment;
  }

  const {NUCLIDE_ORIGINAL_ENV} = process.env;
  if (NUCLIDE_ORIGINAL_ENV != null && NUCLIDE_ORIGINAL_ENV.trim() !== '') {
    const envString = new Buffer(NUCLIDE_ORIGINAL_ENV, 'base64').toString();
    cachedOriginalEnvironment = {};
    for (const envVar of envString.split('\0')) {
      // envVar should look like A=value_of_A
      const equalIndex = envVar.indexOf('=');
      if (equalIndex !== -1) {
        cachedOriginalEnvironment[envVar.substring(0, equalIndex)] =
          envVar.substring(equalIndex + 1);
      }
    }
  } else {
    cachedOriginalEnvironment = process.env;
  }
  return cachedOriginalEnvironment;
}

// Returns a string suitable for including in displayed error messages.
export function exitEventToMessage(event: ProcessExitMessage): string {
  if (event.exitCode != null) {
    return `exit code ${event.exitCode}`;
  } else {
    invariant(event.signal != null);
    return `signal ${event.signal}`;
  }
}

export async function getChildrenOfProcess(
  processId: number,
): Promise<Array<ProcessInfo>> {
  const processes = await psTree();

  return processes.filter(processInfo =>
    processInfo.parentPid === processId);
}

/**
 * Get a list of descendants, sorted by increasing depth (including the one with the provided pid).
 */
async function getDescendantsOfProcess(pid: number): Promise<Array<ProcessInfo>> {
  const processes = await psTree();
  let rootProcessInfo;
  const pidToChildren = new MultiMap();
  processes.forEach(info => {
    if (info.pid === pid) {
      rootProcessInfo = info;
    }
    pidToChildren.add(info.parentPid, info);
  });
  const descendants = rootProcessInfo == null ? [] : [rootProcessInfo];
  // Walk through the array, adding the children of the current element to the end. This
  // breadth-first traversal means that the elements will be sorted by depth.
  for (let i = 0; i < descendants.length; i++) {
    const info = descendants[i];
    const children = pidToChildren.get(info.pid);
    descendants.push(...Array.from(children));
  }
  return descendants;
}

function isWindowsPlatform(): boolean {
  return /^win/.test(process.platform);
}

export async function psTree(): Promise<Array<ProcessInfo>> {
  let psPromise;
  const isWindows = isWindowsPlatform();
  if (isWindows) {
    // See also: https://github.com/nodejs/node-v0.x-archive/issues/2318
    psPromise = checkOutput('wmic.exe',
      ['PROCESS', 'GET', 'ParentProcessId,ProcessId,Name']);
  } else {
    psPromise = checkOutput('ps',
      ['-A', '-o', 'ppid,pid,comm']);
  }
  const {stdout} = await psPromise;
  return parsePsOutput(stdout);
}

export function parsePsOutput(
  psOutput: string,
): Array<ProcessInfo> {
  // Remove the first header line.
  const lines = psOutput.split(/\n|\r\n/).slice(1);

  return lines.map(line => {
    const columns = line.trim().split(/\s+/);
    const [parentPid, pid] = columns;
    const command = columns.slice(2).join(' ');

    return {
      command,
      parentPid: parseInt(parentPid, 10),
      pid: parseInt(pid, 10),
    };
  });
}
