import type { ImageContent, UserMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { createMemo, For, Show } from 'solid-js'
import { Message, MessageContent } from '@/components/ai/message.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolImage,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { FileChip } from '@/components/file-chip.solid.tsx'
import { typeLabel } from '@/components/file-kind.ts'
import { Markdown, MentionText } from '@/components/markdown/markdown.solid.tsx'
import { FileUpload, formatAgo, messageItems, useExtensions } from '../sdk/hooks.ts'
import { Contribution, useAllProvided } from '../sdk/contribution.solid.tsx'
import { splitAttachments, uploadedAt, uploadFor } from './attachments.ts'
import type { AttachedFile } from './attachments.ts'
import { ContributionError } from './contribution-error.solid.tsx'
import { MessageActions } from './message-actions.solid.tsx'
import { skillInput, textOf } from './user-text.ts'

function SkillRun(props: { name: string; location: string; body: string }) {
  return (
    <Tool class="bg-background">
      <ToolHeader
        name="skill"
        state="done"
        title={
          <>
            <span class="text-brand">{props.name}</span>
            <span class="text-muted-foreground/60" title={props.location}>
              {' '}
              · run by you
            </span>
          </>
        }
      />
      <ToolContent>
        <ToolSection>
          <Markdown class="text-[13px]" text={props.body} />
        </ToolSection>
      </ToolContent>
    </Tool>
  )
}

function SentFile(props: { file: AttachedFile; at?: number }) {
  const uploads = useAllProvided(FileUpload, () => null)
  const upload = () =>
    uploadFor(
      uploads().filter((value) => value !== undefined),
      props.file.mimeType,
    )
  const uploaded = () => uploadedAt(props.file.path) ?? props.at
  const gone = () => {
    const kept = upload()?.keptMs
    const at = uploaded()
    return kept !== undefined && at !== undefined && Date.now() - at > kept
  }
  return (
    <FileChip
      gone={gone()}
      mimeType={props.file.mimeType}
      name={props.file.name}
      note={
        gone()
          ? `Removed after ${Math.round(upload()!.keptMs / 86_400_000)} days`
          : `${props.file.size} · ${typeLabel(props.file.name, props.file.mimeType)}`
      }
      title={`${props.file.path || props.file.name}${uploaded() ? `\nattached ${formatAgo(uploaded()!, Date.now(), { ago: true })}` : ''}`}
    />
  )
}

export function UserText(props: { text: string; class?: string }) {
  return (
    <p class={cn('break-words whitespace-pre-wrap', props.class)}>
      <MentionText text={props.text} />
    </p>
  )
}

export function UserView(props: { entry: EntryRecord; message: UserMessage; text?: string }) {
  const text = () => props.text ?? textOf(props.message.content)
  const images = createMemo(() =>
    typeof props.message.content === 'string'
      ? []
      : props.message.content.filter((block): block is ImageContent => block.type === 'image'),
  )
  const parts = createMemo(() => splitAttachments(text()))
  const skill = createMemo(() => skillInput(parts().text))
  const words = () => {
    const run = skill()
    return run ? run.request : parts().text
  }
  const extensions = useExtensions()
  const additions = createMemo(() => messageItems(extensions(), 'userBubble'))
  return (
    <Message class="group/message mt-3 first:mt-0" from="user">
      <div class="relative">
        <MessageContent>
          <Show when={skill()}>{(run) => <SkillRun {...run()} />}</Show>
          <Show when={words()}>
            <UserText text={words()} />
          </Show>
          <Show when={images().length + parts().files.length > 0}>
            <div class="flex flex-wrap gap-2">
              <For each={images()}>
                {(image, index) => (
                  <ToolImage alt={`Attached image ${index() + 1}`} image={image} />
                )}
              </For>
              <For each={parts().files}>
                {(file) => <SentFile at={props.message.timestamp} file={file} />}
              </For>
            </div>
          </Show>
        </MessageContent>
        <For each={additions()} keyed={(item) => item.key}>
          {(item) => (
            <Contribution
              fallback={(extension, error) => (
                <ContributionError error={error} extension={extension} inline />
              )}
              item={item()}
              props={{ entry: props.entry }}
            />
          )}
        </For>
      </div>
      <MessageActions
        class="-mt-1 justify-end"
        entry={props.entry}
        text={text()}
        timestamp={props.message.timestamp}
      />
    </Message>
  )
}
