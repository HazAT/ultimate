import type { ImageContent, TextContent, UserMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { MentionText, Message, MessageContent } from '@/components/ai/message'
import { MessageResponse } from '@/components/ai/message'
import { Tool, ToolContent, ToolHeader, ToolImage, ToolSection } from '@/components/ai/tool'
import { cn } from 'cn'
import { FileChip, typeLabel } from '@/components/file-chip'
import { formatAgo } from '../sdk/format.ts'
import { useExtensions } from '../sdk/hooks.ts'
import { FileUpload } from '../sdk/types.ts'
import { splitAttachments, uploadedAt } from './attachments.ts'
import type { AttachedFile } from './attachments.ts'
import { Provided } from './boundary.tsx'
import { messageItems } from '../sdk/registry.ts'
import { ExtensionBoundary } from './boundary.tsx'
import { MessageActions } from './message-actions.tsx'

/** The text blocks of a user message, joined. */
export function textOf(content: string | readonly (TextContent | ImageContent)[]) {
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** A `/skill:name args` input as the server expanded it (Pi's `<skill>` block): the skill, its body, and the request. */
export function skillInput(text: string) {
  const match =
    /^<skill name="([^"]+)" location="([^"]+)">\nReferences are relative to [^\n]*\n\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]*))?$/.exec(
      text,
    )
  return match
    ? { name: match[1], location: match[2], body: match[3], request: match[4] ?? '' }
    : undefined
}

/** The skill an input ran, folded: its name in the header, its instructions inside. */
function SkillRun({ name, location, body }: { name: string; location: string; body: string }) {
  return (
    <Tool className="bg-background">
      <ToolHeader
        name="skill"
        state="done"
        title={
          <>
            <span className="text-brand">{name}</span>
            <span className="text-muted-foreground" title={location}>
              {' '}
              · run by you
            </span>
          </>
        }
      />
      <ToolContent>
        <ToolSection>
          <MessageResponse className="text-[0.8125rem]">{body}</MessageResponse>
        </ToolSection>
      </ToolContent>
    </Tool>
  )
}

/** A file a sent message references, as its chip; dimmed once the host's retention has removed it. */
function SentFile({ file, at }: { file: AttachedFile; at?: number }) {
  const uploaded = uploadedAt(file.path) ?? at
  return (
    <Provided input={null} point={FileUpload}>
      {(upload) => {
        const gone = !!upload && uploaded !== undefined && Date.now() - uploaded > upload.keptMs
        return (
          <FileChip
            gone={gone}
            mimeType={file.mimeType}
            name={file.name}
            note={
              gone
                ? `Removed after ${Math.round(upload.keptMs / 86_400_000)} days`
                : `${file.size} · ${typeLabel(file.name, file.mimeType)}`
            }
            title={`${file.path}${uploaded ? `\nattached ${formatAgo(uploaded, Date.now(), { ago: true })}` : ''}`}
          />
        )
      }}
    </Provided>
  )
}

/** The user's words as written, with mentions as chips: the body of every user turn. */
export function UserText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn('break-words whitespace-pre-wrap', className)}>
      <MentionText text={text} />
    </p>
  )
}

/**
 * A turn of the user's: its text as written, with mentions as chips, and its images. `text` replaces the message's own,
 * such as the user's words inside a message an extension delivered.
 */
export function UserView({
  entry,
  message,
  text = textOf(message.content),
}: {
  entry: EntryRecord
  message: UserMessage
  text?: string
}) {
  const images =
    typeof message.content === 'string'
      ? []
      : message.content.filter((block) => block.type === 'image')
  const { text: words, files } = splitAttachments(text)
  const skill = skillInput(words)
  const additions = messageItems(useExtensions(), 'userBubble')
  return (
    <Message className="group/message mt-3 first:mt-0" from="user">
      <div className="relative">
        <MessageContent>
          {skill && <SkillRun {...skill} />}
          {(!skill || skill.request) && words && <UserText text={skill ? skill.request : words} />}
          {images.length + files.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((image, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- Fixed message attachments may contain duplicates.
                <ToolImage alt={`Attached image ${index + 1}`} image={image} key={index} />
              ))}
              {files.map((file, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- The same file may be referenced twice.
                <SentFile at={message.timestamp} file={file} key={index} />
              ))}
            </div>
          )}
        </MessageContent>
        {additions.map(({ key, extension, version, component: Addition }) => (
          <ExtensionBoundary extension={extension} fallback={null} key={key} version={version}>
            <Addition entry={entry} />
          </ExtensionBoundary>
        ))}
      </div>
      <MessageActions
        className="-mt-1 justify-end"
        entry={entry}
        text={text}
        timestamp={message.timestamp}
      />
    </Message>
  )
}
