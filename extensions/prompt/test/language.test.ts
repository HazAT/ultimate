import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { fauxServer, temp, removeTemp } from '../../../test/helpers.ts'
import { detectLanguage, PersonLanguage } from '../server.ts'

it('detects the language of typed text by script and common words', () => {
  expect(detectLanguage('你好，请帮我看看这个文件')).toBe('Chinese')
  expect(detectLanguage('このファイルを見てください')).toBe('Japanese')
  expect(detectLanguage('이 파일을 봐 주세요')).toBe('Korean')
  expect(detectLanguage('Посмотри этот файл')).toBe('Russian')
  expect(detectLanguage('please look at this file')).toBe('English')
  expect(detectLanguage('por favor mira este archivo')).toBe('Spanish')
  expect(detectLanguage("qu'est-ce que c'est ?")).toBe('French')
  expect(detectLanguage('···')).toBeUndefined()
  expect(detectLanguage('qwyzx')).toBeUndefined()
})

it('persists the person language from typed inputs only, and anchors it in the prompt', async () => {
  const home = await temp()
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const submit = (content: string, kind?: string) =>
      server.root.submit(
        kind
          ? {
              type: 'input',
              content,
              entry: { kind, data: {} },
            }
          : { type: 'input', content },
        context,
      )
    // An automated input is not the person: it writes nothing.
    await (await submit('please look at this file', 'automations.fired')).wait(context)
    expect(await server.harness.snapshot(PersonLanguage, server.root.id, context)).toBeUndefined()

    // A typed input sets the language.
    await (await submit('你好，请帮我看看这个文件')).wait(context)
    expect(await server.harness.snapshot(PersonLanguage, server.root.id, context)).toEqual({
      language: 'Chinese',
    })

    // The doc is conversation state, not history: it survives a reset of the conversation.
    await server.root.reset(undefined, context)
    expect(await server.harness.snapshot(PersonLanguage, server.root.id, context)).toEqual({
      language: 'Chinese',
    })

    const section = server.host.registry
      .snapshot()
      .extension('prompt')!
      .sections!.find((candidate) => candidate.key === 'language')!
    const agent = await server.root.agent(context)
    const rendered = await section.render(
      {
        conversationId: server.root.id,
        agent,
        env: { cwd: projectRoot },
        read: server.harness,
      } as unknown as Parameters<typeof section.render>[0],
      context,
    )
    expect(rendered).toContain('The person writes in Chinese — answer in it')
    expect(rendered).toContain('hint')
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
