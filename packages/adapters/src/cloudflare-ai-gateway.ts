import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import {
  cloudflareConfigMessage,
  cloudflareModelRouting,
  isCloudflareModelProvider,
} from "@rakazo/contracts";

const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID_ENV = "CLOUDFLARE_GATEWAY_ID";

/**
 * Pi needs request-scoped account routing alongside the key. A gateway also
 * needs its gateway ID; direct Workers AI uses the account endpoint.
 */
export function cloudflareModelProviderEnv(
  model: Pick<AgentRunModel, "provider" | "accountId" | "gatewayId">,
): Record<string, string> | undefined {
  if (!isCloudflareModelProvider(model.provider)) return undefined;
  const routing = cloudflareModelRouting(model.provider, model);
  if (!routing) throw new Error(cloudflareConfigMessage(model.provider));
  return {
    [CLOUDFLARE_ACCOUNT_ID_ENV]: routing.accountId,
    ...(routing.gatewayId ? { [CLOUDFLARE_GATEWAY_ID_ENV]: routing.gatewayId } : {}),
  };
}

export function withCloudflareModelAuth(
  model: Pick<AgentRunModel, "provider" | "accountId" | "gatewayId">,
  options: ModelsSimpleStreamOptions | undefined,
): ModelsSimpleStreamOptions | undefined {
  const env = cloudflareModelProviderEnv(model);
  if (!env) return options;
  // Cloudflare uses 429 for both temporary throttling and an exhausted daily
  // allowance. Let the runtime classify the error and choose a backup before
  // retrying; Pi's status-only retry cannot distinguish those cases.
  return { ...options, maxRetries: 0, env: { ...options?.env, ...env } };
}
