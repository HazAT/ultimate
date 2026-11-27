export const unwrappedProviderError = (error: string) =>
  /upstream said: (.+)\)$/s.exec(error)?.[1] ??
  /"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(error)?.[1]?.replaceAll('\\"', '"') ??
  error
