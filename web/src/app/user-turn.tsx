import type { ImageContent, TextContent, UserMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { Message, MessageContent } from '@/components/ai/message'
import { MessageResponse } from '@/components/ai/message'
import { Tool, ToolContent, ToolHeader, ToolImage, ToolSection } from '@/components/ai/tool'
import { useExtensions } from '../sdk/hooks.ts'
import { messageItems } from '../sdk/registry.ts'
import { ExtensionBoundary } from './boundary.tsx'
import { FoldedText } from './folded-text.tsx'
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
            <span className="text-muted-foreground/60" title={location}>
              {' '}
              · run by you
            </span>
          </>
        }
      />
      <ToolContent>
        <ToolSection>
          <MessageResponse className="text-[13px]">{body}</MessageResponse>
        </ToolSection>
      </ToolContent>
    </Tool>
  )
}

/** The user's words as written, with mentions as chips: the body of every user turn, a long one folded. */
export function UserText({ text, className }: { text: string; className?: string }) {
  return <FoldedText className={className} text={text} />
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
  const skill = skillInput(text)
  const additions = messageItems(useExtensions(), 'userBubble')
  return (
    <Message className="group/message mt-3 first:mt-0" from="user">
      <div className="relative">
        <MessageContent>
          {skill && <SkillRun {...skill} />}
          {(!skill || skill.request) && <UserText text={skill ? skill.request : text} />}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((image, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- Fixed message attachments may contain duplicates.
                <ToolImage alt={`Attached image ${index + 1}`} image={image} key={index} />
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
