export { ensureCA } from './ca.js';
export type { CAFiles } from './ca.js';
export { HostProxy } from './host-proxy.js';
export type { HostProxyOptions } from './host-proxy.js';
export { runProxyProcess } from './process.js';
export type { ProxyProcessHandle } from './process.js';
export { applyPolicies, matchDomain } from './substitution.js';
export type {
  EvaluationOutcome,
  SubstitutionResolver,
} from './substitution.js';
