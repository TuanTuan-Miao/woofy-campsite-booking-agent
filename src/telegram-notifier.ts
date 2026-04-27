type FetchLike = typeof fetch;

export interface Notifier {
  sendMessage(text: string): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly token?: string,
    private readonly chatId?: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async sendMessage(text: string): Promise<void> {
    const token = this.token ?? process.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.chatId ?? process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return;
    }

    const url = new URL(`https://api.telegram.org/bot${token}/sendMessage`);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with ${response.status}`);
    }
  }
}
