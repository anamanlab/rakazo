/** Catalog id for the Cloudflare AI Gateway provider shipped by the model runtime. */
export const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";
export const CLOUDFLARE_WORKERS_AI_PROVIDER_ID = "cloudflare-workers-ai";
export const CLOUDFLARE_WORKERS_AI_CONFIG_MESSAGE = "Cloudflare Workers AI needs an account ID.";

/**
 * A key alone cannot route this provider. The runtime interpolates these ids
 * into the gateway base URL and refuses the provider when either is missing.
 */
export const CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE =
  "Cloudflare AI Gateway needs an account ID and a gateway ID.";

/** Ids are substituted into a URL path, so only a single path segment is accepted. */
const CLOUDFLARE_GATEWAY_ROUTING_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isCloudflareAiGatewayProvider(provider: string): boolean {
  return provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
}

export function isCloudflareModelProvider(provider: string): boolean {
  return isCloudflareAiGatewayProvider(provider) || provider === CLOUDFLARE_WORKERS_AI_PROVIDER_ID;
}

export function cloudflareConfigMessage(provider: string): string {
  return isCloudflareAiGatewayProvider(provider)
    ? CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE
    : CLOUDFLARE_WORKERS_AI_CONFIG_MESSAGE;
}

/** Direct Workers AI needs only an account; the gateway additionally needs its gateway ID. */
export function cloudflareModelRouting(
  provider: string,
  input: { accountId?: string | null; gatewayId?: string | null },
): { accountId: string; gatewayId?: string } | undefined {
  if (!isCloudflareModelProvider(provider)) return undefined;
  if (isCloudflareAiGatewayProvider(provider)) return cloudflareGatewayRouting(input);
  const accountId = cloudflareGatewayRoutingId(input.accountId);
  return accountId ? { accountId } : undefined;
}

export function cloudflareGatewayRoutingId(value: string | null | undefined): string | undefined {
  const id = value?.trim() ?? "";
  return CLOUDFLARE_GATEWAY_ROUTING_ID.test(id) ? id : undefined;
}

export function cloudflareGatewayRouting(input: {
  accountId?: string | null;
  gatewayId?: string | null;
}): { accountId: string; gatewayId: string } | undefined {
  const accountId = cloudflareGatewayRoutingId(input.accountId);
  const gatewayId = cloudflareGatewayRoutingId(input.gatewayId);
  if (!accountId || !gatewayId) return undefined;
  return { accountId, gatewayId };
}
