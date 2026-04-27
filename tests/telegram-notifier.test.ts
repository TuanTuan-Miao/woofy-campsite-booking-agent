import { describe, expect, it, vi } from "vitest";

import { TelegramNotifier } from "../src/telegram-notifier.js";

describe("TelegramNotifier", () => {
  it("posts messages to the configured telegram bot", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const notifier = new TelegramNotifier("bot-token", "chat-id", fetchMock as unknown as typeof fetch);

    await notifier.sendMessage("hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const init = calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain('"chat_id":"chat-id"');
    expect(String(init?.body)).toContain('"text":"hello"');
  });
});
