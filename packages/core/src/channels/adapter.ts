import type { NormalizedMessage, OutgoingMessage } from "./types.js";
import type { ChannelSendResult } from "@rome-os/app-runtime";

/**
 * The message-moving port resolved by the rest of Rome. Concrete channel
 * adapters retain their lifecycle methods for registry integrations, but the
 * registry exclusively owns starting and stopping transports.
 */
export interface ProviderAdapter {
  readonly channelName: string;

  sendMessage(
    channelUserId: string,
    threadId: string,
    message: OutgoingMessage,
  ): Promise<ChannelSendResult | void>;

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void;
}
