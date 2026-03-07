-- Force default model chain to gpt-4o-mini for candidate/admin/interview runtime.
UPDATE "SystemConfig"
SET
  "aiModel" = 'gpt-4o-mini',
  "aiModelAlias" = 'gpt-4o-mini',
  "aiModelOverride" = 'gpt-4o-mini',
  "adminAiModel" = 'gpt-4o-mini',
  "adminAiModelAlias" = 'gpt-4o-mini',
  "adminAiModelOverride" = 'gpt-4o-mini',
  "interviewAiModel" = 'gpt-4o-mini',
  "interviewAiModelAlias" = 'gpt-4o-mini',
  "interviewAiModelOverride" = 'gpt-4o-mini',
  "candidateMaxOutputTokens" = COALESCE("candidateMaxOutputTokens", 320)
WHERE "id" = 1;
