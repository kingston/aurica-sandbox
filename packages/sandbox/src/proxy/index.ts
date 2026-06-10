export { ensureCA } from './ca.js';
export type { CAFiles } from './ca.js';
export { HostProxy } from './host-proxy.js';
export type { HostProxyOptions } from './host-proxy.js';
export { resolvedProxyPort, runProxyProcess } from './process.js';
export type { ProxyProcessHandle } from './process.js';
export {
  BYPASS_ALL,
  DOMAIN_PRESETS,
  expandDomainTokens,
} from './domain-presets.js';
export { applyPolicies, matchDomain, policyId } from './substitution.js';
export type {
  EvaluationOutcome,
  SubstitutionResolver,
} from './substitution.js';
