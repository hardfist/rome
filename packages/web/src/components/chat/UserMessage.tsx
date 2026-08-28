import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "@/components/chat/ChatMarkdown";
import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import type { ChatMessage, StreamBlock } from "@/lib/chat-types";
import { formatMessageTimestamp } from "@/lib/message-timestamp";

// Isolated so that streaming-driven re-renders of ChatPage do not re-parse
// every historical user message through ReactMarkdown on every snapshot tick.
// The custom comparator survives `loadMessages` refresh — that path mints new
// ChatMessage object identities even though id+content are unchanged.
export const UserMessage = memo(
  function UserMessage({ msg }: { msg: ChatMessage }) {
    const { t } = useTranslation("chat");
    const text = useMemo(() => {
      let blocks: StreamBlock[];
      try {
        const parsed = JSON.parse(msg.content);
        blocks = Array.isArray(parsed) ? parsed : [{ type: "text", content: msg.content }];
      } catch {
        blocks = [{ type: "text", content: msg.content }];
      }
      return blocks
        .filter((b) => b.type === "text")
        .map((b) => b.content)
        .join("\n");
    }, [msg.content]);
    const timestamp = useMemo(() => formatMessageTimestamp(msg.createdAt), [msg.createdAt]);
    // Some user turns carry only a structured part with no text (e.g. an
    // interaction_result, whose inline component re-renders its own read-only
    // state), so suppress the empty bubble.
    if (!text) return null;
    // The guardian's own messages stay as a right-aligned bubble — no avatar or
    // name, since there's only ever one human in the conversation.
    return (
      <div className="group mb-4 flex flex-col items-end">
        {/* One inset on every side, equal to `--markdown-block-space-between`
            at this density. A rim narrower than the space the renderer puts
            between two paragraphs reads as content spilling out of the box. */}
        <div className="max-w-[70%] break-words rounded-12 bg-surface-muted p-4">
          <Markdown className="text-foreground" compact={false} preserveSoftBreaks>
            {text}
          </Markdown>
        </div>
        {msg.inputState && msg.inputState !== "consumed" ? (
          <span className="mt-1 text-aux text-muted-foreground" role="status">
            {t(`inputState.${msg.inputState}`)}
          </span>
        ) : null}
        {/* Timestamp + copy under the bubble. Hover-revealed on pointer
            devices, always visible on touch. Precision tracks recency: time
            of day today, month + day this year, full date for older years. */}
        <div className="mt-1 -mr-1 flex items-center gap-2 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100">
          {timestamp ? <span className="text-aux text-muted-foreground">{timestamp}</span> : null}
          <CopyMessageButton text={text} />
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.inputState === next.msg.inputState,
);
