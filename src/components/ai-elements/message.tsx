"use client";

import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { ChatStreamingProvider } from "./chat-code";
import { MarkdownCode } from "./markdown-code";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user"
        ? "is-user ml-auto max-w-[85%] items-end justify-end"
        : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "select-text flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-[12px] leading-relaxed",
      "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-sm group-[.is-user]:bg-muted/70 group-[.is-user]:px-3 group-[.is-user]:py-2 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:w-full group-[.is-assistant]:max-w-full group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  streaming?: boolean;
};

const streamdownComponents = { code: MarkdownCode };

export const MessageResponse = memo(
  ({ className, streaming = false, ...props }: MessageResponseProps) => (
    <ChatStreamingProvider value={streaming}>
      <Streamdown
        className={cn(
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className,
        )}
        components={streamdownComponents}
        {...props}
      />
    </ChatStreamingProvider>
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.streaming === nextProps.streaming &&
    nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";
