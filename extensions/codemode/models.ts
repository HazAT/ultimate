// Pi upstream: @earendil-works/pi-coding-agent@1.5.2 dist/extensions/codemode/execute.js — adapted createModelGlobals, createLimiter and core/usage-totals.js combineUsage, with the context checks and MODELS_DESCRIPTION of pi-durable's dist/codemode/models.js; neither package exports them. Drop when Pi exports codemode's models.* globals.
import type {
  AnyModel,
  AssistantImages,
  ClassifierContext,
  ClassifierResult,
  ImagesContext,
  Models,
  ModelType,
  ModelTypeMap,
  Usage,
} from '@earendil-works/pi-ai'
import { isModelType } from '@earendil-works/pi-ai'
import type { CodemodeTool } from '@earendil-works/pi-codemode'

export const MAX_CONCURRENT_MODEL_CALLS = 4

const MODEL_TYPES: readonly ModelType[] = ['chat', 'image', 'classifier']

export const MODELS_DESCRIPTION = [
  '`models` (all functions return promises):',
  '- `models.getModelsOfType(type, provider?)`, `models.getAvailableOfType(type, provider?)` (configured auth only), `models.getModelOfType(type, provider, id)`: the catalog; `type` is "chat", "image", or "classifier".',
  '- `models.classify(model, { state: { ... }, images?: [{ type: "image", data, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } })` resolves to `{ answers: { <id>: ... }, stopReason, errorMessage?, usage? }`.',
  '- `models.generateImages(model, { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data, mimeType }] })` resolves to `{ output: [image blocks], stopReason, errorMessage?, usage? }`; show each image with `image(block)`.',
  `At most ${MAX_CONCURRENT_MODEL_CALLS} classify/generateImages calls run at once; more wait. Classified state and image prompts go to the model's provider.`,
].join('\n')

const CLASSIFIER_CONTEXT_SHAPE =
  '{ state: { ... }, images?: [{ type: "image", data: <base64>, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function describeValue(value: unknown) {
  if (value === undefined || value === null) return String(value)
  if (Array.isArray(value)) return value.length === 0 ? 'an empty array' : 'an array'
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    return `{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', ...' : ''} }`
  }
  return typeof value === 'string' ? 'a string' : `a ${typeof value}`
}

const withArticle = (word: string) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`

function toModelType(value: unknown): ModelType {
  if (MODEL_TYPES.includes(value as ModelType)) return value as ModelType
  throw new Error(
    `Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`,
  )
}

function toProvider(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('provider must be a string')
  return value
}

function toModelInfo(model: AnyModel): unknown {
  const { headers: _credentials, ...info } = model
  return JSON.parse(JSON.stringify(info))
}

function checkClassifierContext(context: unknown): ClassifierContext {
  const fail = (problem: string) =>
    new Error(`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}.`)
  if (!isRecord(context))
    throw fail(`expects a context object as its second argument, got ${describeValue(context)}`)
  if (!isRecord(context.state))
    throw fail(`context.state must be an object, got ${describeValue(context.state)}`)
  const { images, questions } = context
  if (images !== undefined) {
    if (!Array.isArray(images))
      throw fail(`context.images must be an array, got ${describeValue(images)}`)
    images.forEach((image: unknown, index) => {
      if (
        !isRecord(image) ||
        image.type !== 'image' ||
        typeof image.data !== 'string' ||
        typeof image.mimeType !== 'string'
      )
        throw fail(`context.images[${index}] must be an image block, got ${describeValue(image)}`)
    })
  }
  if (!isRecord(questions) || Object.keys(questions).length === 0)
    throw fail(
      `context.questions must map question IDs to questions, got ${describeValue(questions)}`,
    )
  const isStrings = (values: unknown[]) =>
    values.length > 0 && values.every((value) => typeof value === 'string')
  for (const [id, question] of Object.entries(questions)) {
    const at = `context.questions.${id}`
    if (!isRecord(question))
      throw fail(`${at} must be a question object, got ${describeValue(question)}`)
    if (typeof question.instructions !== 'string') throw fail(`${at}.instructions must be a string`)
    const { criteria } = question
    if (question.type === 'choice') {
      if (!isRecord(criteria) || !isStrings(Object.values(criteria)))
        throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`)
    } else if (question.type === 'score') {
      if (!Array.isArray(criteria) || !isStrings(criteria))
        throw fail(
          `${at} is a "score" question, so criteria must list the levels as strings, lowest first`,
        )
    } else if (question.type === 'bool') {
      if (
        !isRecord(criteria) ||
        typeof criteria.true !== 'string' ||
        typeof criteria.false !== 'string'
      )
        throw fail(
          `${at} is a "bool" question, so criteria must be { true: string, false: string }`,
        )
    } else
      throw fail(
        `${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`,
      )
  }
  return context as unknown as ClassifierContext
}

function checkImagesContext(context: unknown): ImagesContext {
  const fail = (problem: string) =>
    new Error(
      `models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } references] }.`,
    )
  if (!isRecord(context))
    throw fail(`expects a context object as its second argument, got ${describeValue(context)}`)
  const { input } = context
  if (!Array.isArray(input) || input.length === 0)
    throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(input)}`)
  input.forEach((block: unknown, index) => {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return
    if (
      isRecord(block) &&
      block.type === 'image' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    )
      return
    throw fail(`context.input[${index}] must be a text or image block, got ${describeValue(block)}`)
  })
  return context as unknown as ImagesContext
}

function createLimiter(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(run: () => Promise<T>) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await run()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

export function combineUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
      : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
      : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
      totalFromProvider:
        first.cost.totalFromProvider === true && second.cost.totalFromProvider === true,
    },
  }
}

const callable = (model: AnyModel) =>
  isModelType(model, 'classifier') || isModelType(model, 'image')

export async function modelsAvailable(models: Models, signal?: AbortSignal) {
  const providers = new Set(
    [...models.getModelsOfType('classifier'), ...models.getModelsOfType('image')].map(
      (model) => model.provider,
    ),
  )
  for (const provider of providers)
    if ((await models.getAllAvailable(provider, { signal })).some(callable)) return true
  return false
}

export function modelGlobals(
  models: Models,
  record: (name: string, args: unknown[]) => (status: string) => void,
  addUsage: (usage: Usage) => void,
): CodemodeTool[] {
  const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS)
  const modelRef = (model: unknown) =>
    isRecord(model) && typeof model.provider === 'string' && typeof model.id === 'string'
      ? `${model.provider}/${model.id}`
      : describeValue(model)
  const resolveModel = <T extends 'classifier' | 'image'>(
    name: string,
    type: T,
    model: unknown,
  ): ModelTypeMap[T] => {
    const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`
    if (!isRecord(model) || typeof model.provider !== 'string' || typeof model.id !== 'string') {
      const undefinedHint =
        model === undefined || model === null
          ? ' models.getModelOfType() returns undefined for an unknown provider or id.'
          : ''
      throw new Error(
        `${name}() expects ${withArticle(type)} model as its first argument, got ${describeValue(model)}.${undefinedHint} ${listHint}`,
      )
    }
    const { provider, id } = model
    const resolved = models.getModelOfType(type, provider, id)
    if (resolved) return resolved
    const actualType = MODEL_TYPES.find(
      (other) => other !== type && models.getModelOfType(other, provider, id) !== undefined,
    )
    throw new Error(
      actualType
        ? `"${provider}/${id}" is ${withArticle(actualType)} model, not ${withArticle(type)} model. ${listHint}`
        : `Unknown ${type} model "${provider}/${id}". ${listHint}`,
    )
  }
  const paid = <T extends ClassifierResult | AssistantImages>(result: T) => {
    if (result.usage) addUsage(result.usage)
    return result
  }
  const implementations: Record<string, (args: unknown[], signal: AbortSignal) => unknown> = {
    'models.getModelsOfType': ([type, provider]) =>
      models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo),
    'models.getAvailableOfType': async ([type, provider], signal) =>
      (await models.getAvailableOfType(toModelType(type), toProvider(provider), { signal })).map(
        toModelInfo,
      ),
    'models.getModelOfType': (args) => {
      const [type, provider, id] = args
      if (typeof provider !== 'string' || typeof id !== 'string')
        throw new Error(
          `models.getModelOfType(type, provider, id) expects three strings, got (${args.map(describeValue).join(', ')}). The provider and the id are separate arguments, for example models.getModelOfType("classifier", "typesafe", "jev-latest").`,
        )
      const model = models.getModelOfType(toModelType(type), provider, id)
      return model === undefined ? undefined : toModelInfo(model)
    },
    'models.classify': ([model, context], signal) => {
      const resolved = resolveModel('models.classify', 'classifier', model)
      const checked = checkClassifierContext(context)
      return limit(async () => {
        signal.throwIfAborted()
        return paid(await models.classify(resolved, checked, { signal }))
      })
    },
    'models.generateImages': ([model, context], signal) => {
      const resolved = resolveModel('models.generateImages', 'image', model)
      const checked = checkImagesContext(context)
      return limit(async () => {
        signal.throwIfAborted()
        return paid(await models.generateImages(resolved, checked, { signal }))
      })
    },
  }
  const modelCall = (name: string) => name === 'models.classify' || name === 'models.generateImages'
  return Object.entries(implementations).map(([name, execute]) => ({
    name,
    spread: true,
    execute: async (values, { signal }) => {
      const args = values as unknown[]
      const settle = record(name, modelCall(name) ? [modelRef(args[0])] : args)
      try {
        const value = await execute(args, signal)
        const stopReason = modelCall(name) ? (value as ClassifierResult).stopReason : 'stop'
        settle(stopReason === 'stop' ? 'ok' : stopReason === 'aborted' ? 'cancelled' : 'error')
        return value
      } catch (error) {
        settle(signal.aborted ? 'cancelled' : 'error')
        throw error
      }
    },
  }))
}
