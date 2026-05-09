import { z } from 'zod';

/**
 * Per-host substitution rule applied by the proxy. When `pathPrefix` is set,
 * the rule only fires if the request URL's pathname starts with that prefix
 * (case-sensitive — github paths are case-preserving). Without `pathPrefix`,
 * the rule fires for any path on the matching host.
 */
export const proxyActionSchema = z.object({
  domain: z.string().min(1),
  pathPrefix: z.string().min(1).optional(),
  hook: z.literal('replaceApiKey'),
  header: z.string().min(1),
  placeholderValue: z.string().min(1),
  replacementValue: z.string().min(1),
});

export type ProxyAction = z.infer<typeof proxyActionSchema>;
