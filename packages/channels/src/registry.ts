import type { Channel, ChannelAdapter, Secret } from "@relay/shared";

/** What the gateway knows about a bot once the webhook is verified. Never comes from the payload. */
export interface BotContext {
  tenantId: string;
  botId: string;
  /** sha256 hex of the webhook secret, or null before the bot is registered. */
  webhookSecretHash: string | null;
  /** Present only when the caller needs to send or fetch (inbound handling does not). */
  token?: Secret;
}

export type AdapterFactory = (bot: BotContext) => ChannelAdapter;

/** Maps a channel to the factory that builds its adapter for one bot. */
export class ChannelRegistry {
  private readonly factories = new Map<Channel, AdapterFactory>();

  register(channel: Channel, factory: AdapterFactory): this {
    this.factories.set(channel, factory);
    return this;
  }

  forBot(channel: Channel, bot: BotContext): ChannelAdapter {
    const factory = this.factories.get(channel);
    if (!factory) throw new Error(`no adapter registered for channel ${channel}`);
    return factory(bot);
  }
}
