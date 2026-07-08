"use client";

import { FormEvent, KeyboardEvent, useMemo, useState } from "react";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "你好",
  },
];

const quickPrompts = [
  "你好，请问你是谁？",
];

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");

  const canSend = useMemo(
    () => input.trim().length > 0 && !isSending,
    [input, isSending],
  );

  async function sendMessage(content: string) {
    const trimmedContent = content.trim();

    if (!trimmedContent || isSending) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: trimmedContent,
    };
    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setInput("");
    setError("");
    setIsSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({
            role,
            content,
          })),
        }),
      });

      const data = (await response.json()) as {
        message?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "请求失败，请稍后再试。");
      }

      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: createMessageId(),
          role: "assistant",
          content: data.message ?? "我暂时没有生成有效回复。",
        },
      ]);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "请求失败，请稍后再试。",
      );
    } finally {
      setIsSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  }

  return (
    <main className="flex min-h-dvh bg-[#f6f7f4] text-zinc-950">
      <section className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between border-b border-zinc-200/80 py-4">
          <div>
            <p className="text-sm font-medium text-emerald-700">
              Club Management
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-normal text-zinc-950 sm:text-2xl">
              高校社团管理助手
            </h1>
          </div>
          <div className="hidden rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-600 shadow-sm sm:block">
            AI Chat
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 shadow-sm sm:p-5">
            <div className="flex flex-col gap-4">
              {messages.map((message) => {
                const isUser = message.role === "user";

                return (
                  <article
                    key={message.id}
                    className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[86%] whitespace-pre-wrap rounded-lg px-4 py-3 text-sm leading-6 sm:max-w-[72%] sm:text-base ${
                        isUser
                          ? "bg-emerald-700 text-white"
                          : "border border-zinc-200 bg-zinc-50 text-zinc-800"
                      }`}
                    >
                      {message.content}
                    </div>
                  </article>
                );
              })}

              {isSending ? (
                <article className="flex justify-start">
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm leading-6 text-zinc-600">
                    正在思考...
                  </div>
                </article>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="min-h-11 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-700 shadow-sm transition hover:border-emerald-300 hover:text-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSending}
                onClick={() => void sendMessage(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>

          <form
            onSubmit={handleSubmit}
            className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm"
          >
            <label className="sr-only" htmlFor="chat-input">
              输入消息
            </label>
            <textarea
              id="chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              className="max-h-40 min-h-24 w-full resize-none rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-base leading-6 text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
              placeholder="记录一次活动想法、任务安排或复盘内容..."
            />
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-h-5 text-sm text-red-600" role="status">
                {error}
              </p>
              <button
                type="submit"
                disabled={!canSend}
                className="inline-flex h-11 items-center justify-center rounded-md bg-emerald-700 px-5 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500"
              >
                {isSending ? "发送中" : "发送"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
