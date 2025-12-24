import { normalizeModelId } from './configService';
import { getUniqueModelFallbackChain } from './openAiChatCompletionService';

export type ResolvedModelChain = {
  modelOverride: string | null;
  modelAliasStored: string;
  modelAliasResolved: string;
  modelRequested: string;
  modelChain: string[];
};

export function resolveModelChain(params: {
  modelOverride?: string | null;
  modelAlias?: string | null;
  legacyModel?: string | null;
  defaultModel: string;
}): ResolvedModelChain {
  const override =
    typeof params.modelOverride === 'string' && params.modelOverride.trim()
      ? params.modelOverride.trim()
      : null;
  const aliasStored =
    (typeof params.modelAlias === 'string' && params.modelAlias.trim()
      ? params.modelAlias.trim()
      : '') ||
    (typeof params.legacyModel === 'string' && params.legacyModel.trim()
      ? params.legacyModel.trim()
      : '') ||
    params.defaultModel;
  const aliasResolved = normalizeModelId(aliasStored) || params.defaultModel;
  const requested = (override || aliasResolved || params.defaultModel).trim() || params.defaultModel;
  const chain = getUniqueModelFallbackChain([requested, aliasResolved, params.defaultModel]);
  return {
    modelOverride: override,
    modelAliasStored: aliasStored,
    modelAliasResolved: aliasResolved,
    modelRequested: requested,
    modelChain: chain,
  };
}

