import { z } from 'zod';

/**
 * Optional encoding applied symmetrically to both the placeholder (when
 * matching the on-the-wire header) and the resolved replacement (before
 * substituting it in). Lets us pin a substitution rule to a header value
 * that the client encodes before it leaves the VM, e.g. HTTP Basic auth
 * where git base64-encodes `username:token` into `Authorization: Basic …`.
 *
 * `prefix` is concatenated in front of the value before encoding (e.g.
 * `"username:"` for Basic auth). Empty prefix is allowed if you only need
 * the encoding step.
 */
export const proxyActionTransformSchema = z.object({
  type: z.literal('base64'),
  prefix: z.string(),
});

export type ProxyActionTransform = z.infer<typeof proxyActionTransformSchema>;

/**
 * Per-host substitution rule applied by the proxy. When `pathPrefix` is set,
 * the rule only fires if the request URL's pathname starts with that prefix
 * (case-sensitive — github paths are case-preserving). Without `pathPrefix`,
 * the rule fires for any path on the matching host.
 *
 * When `transform` is set, the proxy searches the header for
 * `transform(prefix + placeholderValue)` and substitutes
 * `transform(prefix + resolve(replacementValue))`. Without `transform`, the
 * raw placeholder is matched and the raw resolved replacement is used.
 */
export const proxyActionSchema = z.object({
  domain: z.string().min(1),
  pathPrefix: z.string().min(1).optional(),
  hook: z.literal('replaceApiKey'),
  header: z.string().min(1),
  placeholderValue: z.string().min(1),
  replacementValue: z.string().min(1),
  transform: proxyActionTransformSchema.optional(),
});

export type ProxyAction = z.infer<typeof proxyActionSchema>;
