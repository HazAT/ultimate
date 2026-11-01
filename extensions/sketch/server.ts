/**
 * Sketch: an agent describes a small UI (a chart, a table, a form) in words, and a fast model draws it as a spec that the
 * transcript renders with Ultimate's own components. Submitted forms come back as the user's input.
 */
import { readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { copyJson } from '@earendil-works/chord'
import type { Context, JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { clampThinkingLevel, Type, validateToolArguments } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  Message,
  Models,
  ModelThinkingLevel,
  Tool,
  ToolCall,
} from '@earendil-works/pi-ai'
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { exec } from '../../lib/exec.ts'
import { implementAction } from '../../lib/actions.ts'
import { discoverAgents, hasLogin, hostDefaultModel, previewModel } from '../../lib/agents.ts'
import { refName } from '../../lib/families.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { SketchFormsDoc, SubmitAction } from './refs.ts'
import type { Block, SketchDetails, SketchForm, Spec, Value } from './refs.ts'

/** The newest calls whose usage is counted, kept to recognise a rerun, which only a recent call can have. */
const COUNTED = 200

export const SketchForms = defineDoc<{ forms: Record<string, SketchForm>; counted: string[] }>({
  kind: SketchFormsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ forms: {}, counted: [] }),
})
export const docs = [SketchForms]

/** Model steps a sketch may take: reads, then `render`, with room for one repair. */
const STEPS = 8
const READ_BYTES = 40_000

const Cell = Type.Union([Type.String(), Type.Number()])
const Field = Type.Object({
  name: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  kind: Type.Union(['text', 'number', 'select', 'toggle', 'date'].map((k) => Type.Literal(k))),
  options: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 20 })),
  default: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
})
const Leaf = Type.Union([
  Type.Object({ type: Type.Literal('text'), markdown: Type.String({ minLength: 1 }) }),
  Type.Object({
    type: Type.Literal('metric'),
    label: Type.String(),
    value: Type.String(),
    delta: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('chart'),
    kind: Type.Union([Type.Literal('bar'), Type.Literal('line')]),
    title: Type.Optional(Type.String()),
    x: Type.String({ description: 'The data field on the x axis' }),
    series: Type.Array(Type.Object({ name: Type.String(), field: Type.String() }), {
      minItems: 1,
      maxItems: 4,
    }),
    data: Type.Array(Type.Record(Type.String(), Cell), { minItems: 1, maxItems: 100 }),
    unit: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('table'),
    columns: Type.Array(Type.Object({ key: Type.String(), label: Type.String() }), {
      minItems: 1,
      maxItems: 8,
    }),
    rows: Type.Array(Type.Record(Type.String(), Type.Union([Cell, Type.Boolean(), Type.Null()])), {
      maxItems: 100,
    }),
  }),
  Type.Object({
    type: Type.Literal('form'),
    submit: Type.String({ minLength: 1, description: 'The submit button label' }),
    fields: Type.Array(Field, { minItems: 1, maxItems: 12 }),
  }),
])
const SpecSchema = Type.Object({
  title: Type.Optional(Type.String()),
  blocks: Type.Array(
    Type.Union([
      Leaf,
      Type.Object({
        type: Type.Literal('row'),
        blocks: Type.Array(Leaf, { minItems: 2, maxItems: 3 }),
      }),
    ]),
    { minItems: 1, maxItems: 6 },
  ),
})

const render: Tool = {
  name: 'render',
  description: 'Draw the UI. Call it exactly once, as your last step.',
  parameters: SpecSchema,
}
const reads: Tool[] = [
  {
    name: 'read',
    description: 'Read a text file of the project (the first 40 KB).',
    parameters: Type.Object({ path: Type.String() }),
  },
  {
    name: 'ls',
    description: 'List a directory of the project.',
    parameters: Type.Object({ path: Type.String({ default: '.' }) }),
  },
  {
    name: 'grep',
    description: 'Search the project with ripgrep; prints path:line:text.',
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
  },
]

const SYSTEM = `You draw small UIs for a coding agent's chat. You get a request and turn it into one spec by calling render.

Blocks: text (markdown), metric (label, value, optional delta like "+12%"), chart (bar or line; x names the data field on
the x axis, each series names a numeric field; data is the rows), table (columns by key, rows), form (fields and a submit
label; its values go back to the agent), row (2–3 blocks side by side; they stack on phones).

Rules:
- Use only numbers that are in the request, the data or files you read; compute totals and averages yourself, carefully.
  Never invent data. When you cannot get the data, answer in one sentence what is missing instead of calling render.
- Keep it small: 1–4 blocks. Short labels; x values like "Tue" or "10-28", not full timestamps.
- No styling or colours: the app themes it.
- Forms: one field per value the agent asked for; select for a few known choices, toggle for yes/no; sensible defaults.`

const READ_RULE = `
- No data was passed: read what you need with ls, grep and read (project files only), then call render.`

type Step = { answer: AssistantMessage; results: Message[]; read: string[] }

/** The spec's blocks with rows opened. */
export const leaves = (spec: Spec) =>
  spec.blocks.flatMap((block) => (block.type === 'row' ? block.blocks : [block]))

/** One line naming what a spec shows, for the calling agent. */
export function describe(spec: Spec) {
  const leaf = (block: Block): string =>
    block.type === 'row'
      ? block.blocks.map(leaf).join(' + ')
      : block.type === 'chart'
        ? `${block.kind} chart (${block.data.length} points)`
        : block.type === 'table'
          ? `table (${block.rows.length} rows)`
          : block.type === 'form'
            ? `form (${block.fields.map((field) => field.name).join(', ')})`
            : block.type
  return `${spec.title ? `${spec.title}: ` : ''}${spec.blocks.map(leaf).join(', ')}`
}

/** `path` inside `root`, resolved through links; throws outside it. */
async function inside(root: string, path: string) {
  const real = await realpath(resolve(root, path))
  const rel = relative(await realpath(root), real)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${path} is outside the project`)
  return real
}

async function runRead(root: string, call: ToolCall, signal: AbortSignal) {
  const args = call.arguments as { path?: string; pattern?: string }
  const path = typeof args.path === 'string' && args.path ? args.path : '.'
  if (call.name === 'read') {
    const text = await readFile(await inside(root, path), 'utf8')
    return text.length > READ_BYTES ? `${text.slice(0, READ_BYTES)}\n[cut at 40 KB]` : text
  }
  if (call.name === 'ls') {
    const entries = await readdir(await inside(root, path), { withFileTypes: true })
    return entries
      .slice(0, 300)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .join('\n')
  }
  if (call.name === 'grep' && typeof args.pattern === 'string') {
    // The checked real path itself, and no config file that could turn on --follow or preprocessors.
    const target = await inside(root, path)
    const { stdout } = await exec(
      'rg',
      [
        '--no-config',
        '-n',
        '--max-count',
        '50',
        '--max-columns',
        '300',
        '--',
        args.pattern,
        target,
      ],
      { cwd: await realpath(root), signal, maxBuffer: 4_000_000 },
    ).catch((error: { code?: number; stdout?: string }) => {
      // rg exits 1 when nothing matched.
      if (error.code === 1) return { stdout: '' }
      throw error
    })
    return stdout.slice(0, READ_BYTES) || 'No matches.'
  }
  throw new Error(`Unknown tool ${call.name}`)
}

const errorResult = (call: ToolCall, text: string, isError = true): Message => ({
  role: 'toolResult',
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: 'text', text }],
  isError,
  timestamp: Date.now(),
})

/** The model a sketch asks, kept in the call's memo so a rerun asks the same one. */
export type SketchModel = { provider: string; id: string; thinking: ModelThinkingLevel }

/**
 * What the `sketch` agent definition (`agents/sketch.md`) runs on: a preview's model, else its pin or family's, else the
 * default model. Read at each call, so a family move or an overlay applies to the next sketch.
 */
export async function sketchModel(
  host: Pick<
    ExtensionHost,
    'ultimateRoot' | 'projectRoot' | 'userHome' | 'modelRuntime' | 'settings'
  >,
): Promise<SketchModel> {
  const { definitions } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  const runs = definitions.find((definition) => definition.name === 'sketch')?.runs
  if (!runs)
    throw new Error('No sketch agent definition: restore extensions/sketch/agents/sketch.md')
  const ref = previewModel() ?? runs.model ?? (await hostDefaultModel(host))
  const model = ref && host.modelRuntime.getModel(ref.provider, ref.modelId)
  if (!model || !hasLogin(host.modelRuntime.getAvailableSnapshot(), ref))
    throw new Error(
      `The sketch agent's model ${ref ? refName(ref) : '(none)'} has no login here: log in, or move the sketch agent to another family in the Agents tab`,
    )
  return {
    provider: model.provider,
    id: model.id,
    thinking: clampThinkingLevel(model, runs.thinking ?? 'medium'),
  }
}

export type SketchRun = {
  models: Models
  model: SketchModel
  root: string
  request: string
  data?: string
  signal: AbortSignal
  /** Memoize step `index`: return the stored one, or run `make` and store its result. */
  step(index: number, make: () => Promise<Step>): Promise<Step>
}

/**
 * Ask the model until it renders a valid spec: reads when no data was passed, one repair after an invalid spec. Throws
 * with the model's own words when it renders nothing.
 */
export async function sketch(
  run: SketchRun,
): Promise<{ spec: Spec; read: string[]; steps: Step[] }> {
  const model = run.models.getModel(run.model.provider, run.model.id)
  if (!model) throw new Error(`Model ${run.model.provider}/${run.model.id} is unavailable`)
  const tools = run.data === undefined ? [render, ...reads] : [render]
  const input = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `Request: ${run.request}`,
    ...(run.data === undefined ? [] : [`Data:\n${run.data}`]),
  ].join('\n\n')
  const messages: Message[] = [{ role: 'user', content: input, timestamp: Date.now() }]
  const steps: Step[] = []
  let invalid = 0
  for (let index = 0; index < STEPS; index++) {
    const step = await run.step(index, async () => {
      const answer = await run.models.completeSimple(
        model,
        { systemPrompt: SYSTEM + (run.data === undefined ? READ_RULE : ''), messages, tools },
        {
          ...(run.model.thinking === 'off' ? {} : { reasoning: run.model.thinking }),
          maxTokens: Math.min(8192, model.maxTokens || 8192),
          signal: run.signal,
        },
      )
      if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
        throw new Error(answer.errorMessage ?? `The sketch model stopped: ${answer.stopReason}`)
      const results: Message[] = []
      const read: string[] = []
      for (const call of answer.content.filter((part) => part.type === 'toolCall')) {
        if (call.name === 'render') continue
        try {
          results.push(errorResult(call, await runRead(run.root, call, run.signal), false))
          if (typeof call.arguments.path === 'string') read.push(call.arguments.path)
        } catch (error) {
          results.push(errorResult(call, error instanceof Error ? error.message : String(error)))
        }
      }
      return { answer, results, read }
    })
    steps.push(step)
    messages.push(step.answer, ...step.results)
    const calls = step.answer.content.filter((part) => part.type === 'toolCall')
    const drawn = calls.find((call) => call.name === 'render')
    if (drawn) {
      try {
        const spec = validateToolArguments(render, drawn) as Spec
        if (leaves(spec).filter((block) => block.type === 'form').length > 1)
          throw new Error('A sketch holds at most one form; put all its fields in one form.')
        return { spec, read: steps.flatMap((s) => s.read), steps }
      } catch (error) {
        if (++invalid > 1) throw error
        messages.push(
          errorResult(drawn, `${(error as Error).message}\n\nFix the spec and call render again.`),
        )
        continue
      }
    }
    if (!calls.length) {
      const said = step.answer.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
        .trim()
      throw new Error(`Nothing drawn: ${said || 'the sketch model gave no answer'}`)
    }
  }
  throw new Error(`Nothing drawn after ${STEPS} steps`)
}

/** The user's input for a submitted form: its title, then one `label: value` line per field. */
export function submissionText(form: SketchForm, values: Record<string, Value>) {
  const lines = form.fields.map((field) => `${field.label}: ${values[field.name] ?? ''}`)
  return [`Submitted the form${form.title ? ` "${form.title}"` : ''}:`, ...lines].join('\n')
}

/** Every field's value, checked against its kind; text, number and date may be left empty (""). */
function checkValues(form: SketchForm, values: unknown): Record<string, Value> {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('values must be an object')
  const given = values as Record<string, unknown>
  for (const name of Object.keys(given))
    if (!form.fields.some((field) => field.name === name)) throw new Error(`Unknown field ${name}`)
  return Object.fromEntries(
    form.fields.map((field) => {
      const value = given[field.name]
      const ok =
        field.kind === 'toggle'
          ? typeof value === 'boolean'
          : field.kind === 'select'
            ? typeof value === 'string' && (field.options ?? []).includes(value)
            : field.kind === 'number'
              ? value === '' || (typeof value === 'number' && Number.isFinite(value))
              : field.kind === 'date'
                ? value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
                : typeof value === 'string'
      if (!ok) throw new Error(`${field.label}: expected a ${field.kind} value`)
      return [field.name, value as Value]
    }),
  )
}

/** checkValues lists every field in the form's order, so equal values serialize alike. */
const same = (a: Record<string, Value>, b: Record<string, Value>) =>
  JSON.stringify(a) === JSON.stringify(b)

export const userActions = ['submit']
export const actions = {
  /** Submit the form a `sketch` call drew in the calling conversation, once; its values arrive as the user's input. */
  submit: implementAction(SubmitAction, async (args, { host, conversationId }) => {
    const data = args as { call?: unknown; values?: unknown }
    if (!data || typeof data.call !== 'string' || conversationId === undefined)
      throw new Error('Expected { call, values }')
    const id = conversationId as ConversationId
    const call = data.call
    // Claim and lock in one transaction, so one set of values wins; the claim is then delivered, once per request id,
    // and marked delivered. Until then the card offers to send the claimed values again (after a crash in between);
    // other values are refused.
    const claimed = await host.harness().commit(async (tx) => {
      const form = (await tx.doc(SketchForms, id)).forms[call]
      if (!form) throw new Error('No such form')
      const values = checkValues(form, data.values)
      if (form.submitted && !same(form.submitted.values, values))
        throw new Error('This form was already submitted')
      form.submitted ??= { at: Date.now(), values }
      // A copy: a document read stays valid only inside its transaction.
      return copyJson(form) as SketchForm
    }, context)
    const conversation = await host.harness().conversation(id, context)
    if (!conversation) throw new Error(`No conversation ${id}`)
    await conversation.submit(
      {
        type: 'input',
        requestId: `sketch:${call}`,
        whenBusy: 'followUp',
        content: submissionText(claimed, claimed.submitted!.values),
      },
      context,
    )
    await host.harness().commit(async (tx) => {
      const sent = (await tx.doc(SketchForms, id)).forms[call]?.submitted
      if (sent) sent.delivered = true
    }, context)
    return { ok: true as const }
  }),
}

export default function sketchExtension(host: ExtensionHost) {
  return defineExtension({
    name: 'sketch',
    tools: [
      defineTool({
        name: 'sketch',
        // Every model step and read is memoized, so a rerun draws the same spec.
        replay: 'safe',
        // Callers often pass rows as JSON rather than a string: take it as its JSON text.
        prepareArguments(args) {
          const input = args as { request: string; data?: unknown }
          // Validation still checks the result.
          return (
            input && input.data !== undefined && typeof input.data !== 'string'
              ? { ...input, data: JSON.stringify(input.data) }
              : input
          ) as { request: string; data?: string }
        },
        description:
          "Show the user a small UI in the transcript, drawn by a fast model from your words: charts (bar, line), tables, metrics, short text and forms. Say what to show and how; pass the numbers or rows in data when you have them, or omit data and name the files to read. A form's submitted values come back to you as the user's next input. Takes a few seconds; returns one line naming what was drawn. Call it directly, never inside codemode: a nested call draws no card.",
        parameters: Type.Object({
          request: Type.String({
            minLength: 1,
            description:
              'What to show, in words: "a bar chart of landings per day with the total beside it", "a form asking for the release name and date".',
          }),
          data: Type.Optional(
            Type.String({
              description:
                'The data to show, as JSON, CSV or plain text. Omit it to let the sketch model read project files the request names.',
            }),
          ),
        }),
        async execute(args, api, ctx: Context) {
          const conversations = host.need(ConversationsApi)
          // Memoized, so a rerun asks the model the first run asked.
          const model =
            (await api.memo<SketchModel>('model', ctx)) ??
            (await api.memo('model', await sketchModel(host), ctx))
          const root = (await api.agent(ctx)).cwd ?? host.projectRoot
          const { spec, read, steps } = await sketch({
            models: api.models,
            model,
            root,
            request: args.request,
            data: args.data,
            signal: ctx.abortSignal ?? new AbortController().signal,
            step: async (index, make) =>
              ((await api.memo<JsonValue>(`step-${index}`, ctx)) as Step | undefined) ??
              ((await api.memo(
                `step-${index}`,
                copyJson(await make(), { omitUndefinedProperties: true }),
                ctx,
              )) as unknown as Step),
          })
          const at = (await api.memo<number>('at', ctx)) ?? (await api.memo('at', Date.now(), ctx))
          const form = leaves(spec).find((block) => block.type === 'form')
          // Recorded with the usage in one transaction: a rerun after a restart neither counts it again nor reopens a
          // sent form.
          await api.commit(async (tx) => {
            const doc = await tx.doc(SketchForms, api.conversationId)
            if (doc.counted.includes(api.callId)) return
            doc.counted = [...doc.counted, api.callId].slice(-COUNTED)
            for (const step of steps)
              await conversations.accountResponse(tx, api.conversationId, {
                provider: step.answer.provider,
                model: step.answer.model,
                usage: step.answer.usage,
                text: '',
                stopReason: step.answer.stopReason,
              })
            if (form)
              doc.forms[api.callId] = {
                ...(spec.title ? { title: spec.title } : {}),
                fields: form.fields,
              }
          }, ctx)
          const details: SketchDetails = {
            spec,
            at,
            model: `${model.provider}/${model.id}`,
            ...(read.length ? { read: [...new Set(read)] } : {}),
          }
          await api.details(details as unknown as JsonValue, ctx)
          const text = `Drew ${describe(spec)}.${form ? " Its submitted values arrive as the user's next input." : ''}`
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
