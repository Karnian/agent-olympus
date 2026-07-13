const SafePromise = Promise;
const SafeProxy = Proxy;
const safeSetImmediate = setImmediate;
const safeApply = Reflect.apply;
const safeConstruct = Reflect.construct;

function schedule(operation) {
  return new SafePromise((resolve, reject) => {
    safeSetImmediate(() => {
      try {
        resolve(operation());
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Import candidate code across an async boundary that does not expose grader frames. */
export function importCandidate(moduleUrl) {
  return schedule(() => import(moduleUrl));
}

/** Invoke a candidate export without putting the task grader on its sync stack. */
export function invokeCandidate(fn, args = [], thisArg = undefined) {
  return schedule(() => safeApply(fn, thisArg, args));
}

/** Construct a candidate class without putting the task grader on its sync stack. */
export function constructCandidate(Ctor, args = []) {
  return schedule(() => safeConstruct(Ctor, args));
}

/** Invoke one candidate object method behind the same generic trampoline. */
export function invokeCandidateMethod(target, method, args = []) {
  return schedule(() => safeApply(target?.[method], target, args));
}

/**
 * Hide a task grader callback's source text from candidate code. A callable
 * Proxy keeps the callback's exact behavior, while Function#toString exposes
 * only a native proxy facade instead of the hidden grader body.
 */
export function opaqueCallback(callback) {
  if (typeof callback !== 'function') throw new TypeError('opaqueCallback requires a function');
  return new SafeProxy(callback, Object.freeze({}));
}
