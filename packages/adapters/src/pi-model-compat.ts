import type { MutableModels } from "@earendil-works/pi-ai";
import { canonicalPiProviderId } from "@rakazo/contracts";

/** Preserve saved provider references and the Bedrock India strict-tools guard. */
export function applyPiModelCompatibility(models: MutableModels): MutableModels {
  const provider = models.getProvider?.("amazon-bedrock");
  if (provider) {
    const guardedId = "in.anthropic.claude-haiku-4-5-20251001-v1:0";
    const guardedModels = provider
      .getModels()
      .map((model) =>
        model.id === guardedId
          ? { ...model, compat: { ...model.compat, supportsStrictMode: false } }
          : model,
      );
    models.setProvider({ ...provider, getModels: () => guardedModels });
  }
  // Groq's OpenAI-compatible endpoint only accepts the system role. Pi marks
  // standard OpenAI-style providers as developer-role capable, so reasoning
  // models such as Qwen3 send "developer" and Groq rejects the chat template.
  const groq = models.getProvider?.("groq");
  if (groq) {
    const groqModels = groq
      .getModels()
      .map((model) => ({
        ...model,
        compat: { ...model.compat, supportsDeveloperRole: false },
      }));
    models.setProvider({ ...groq, getModels: () => groqModels });
  }
  const getModel = models.getModel.bind(models);
  models.getModel = (provider, id) => getModel(canonicalPiProviderId(provider), id);
  const getProvider = models.getProvider?.bind(models);
  if (getProvider) models.getProvider = (provider) => getProvider(canonicalPiProviderId(provider));
  return models;
}
