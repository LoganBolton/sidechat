const SYSTEM_PROMPT = `You are a helpful assistant answering a branching clarification question. The user is in the middle of a conversation and wants to ask a side question without disrupting the main thread. You have access to the full conversation context. If the user highlighted a specific excerpt, focus on that. Otherwise, use the full conversation to inform your answer. Be concise and directly helpful. Do not suggest that the user ask in their main conversation.`;

// Register context menus on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "sidechat-ask",
      title: "Sidechat: Ask about selection",
      contexts: ["selection"],
      documentUrlPatterns: ["https://claude.ai/*"],
    });
    chrome.contextMenus.create({
      id: "sidechat-open",
      title: "Sidechat: Open",
      contexts: ["page"],
      documentUrlPatterns: ["https://claude.ai/*"],
    });
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "sidechat-ask") {
    chrome.tabs.sendMessage(tab.id, {
      type: "sidechat-open",
      selectionText: info.selectionText || "",
    });
  } else if (info.menuItemId === "sidechat-open") {
    chrome.tabs.sendMessage(tab.id, {
      type: "sidechat-open",
      selectionText: "",
    });
  }
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-sidechat" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: "sidechat-open",
      selectionText: "",
    });
  }
});

// Handle port connections for streaming
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidechat-stream") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "sidechat-submit") return;

    try {
      const settings = await chrome.storage.sync.get({
        apiKey: "",
        model: "claude-sonnet-4-20250514",
        maxTokens: 4096,
      });

      if (!settings.apiKey) {
        port.postMessage({
          type: "sidechat-error",
          error:
            "No API key found. Click the Sidechat extension icon to configure your API key.",
        });
        return;
      }

      const messages = buildMessages(
        msg.conversationTurns,
        msg.selectedText,
        msg.question,
        msg.branchHistory || []
      );

      await streamResponse(port, settings, messages);
    } catch (err) {
      port.postMessage({
        type: "sidechat-error",
        error: err.message || "An unexpected error occurred.",
      });
    }
  });
});

function buildMessages(conversationTurns, selectedText, question, branchHistory) {
  const messages = [];

  // Add conversation history
  for (const turn of conversationTurns) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // Add prior branch conversation if any
  for (const msg of branchHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add the new branching question
  if (selectedText) {
    messages.push({
      role: "user",
      content: `I have a side question about the following excerpt from our conversation:\n\n> ${selectedText}\n\nMy question: ${question}`,
    });
  } else {
    messages.push({
      role: "user",
      content: `I have a side question about our conversation:\n\n${question}`,
    });
  }

  // Ensure messages start with a user message (API requirement)
  if (messages.length > 0 && messages[0].role !== "user") {
    messages.unshift({
      role: "user",
      content: "(Start of conversation context)",
    });
  }

  return messages;
}

async function streamResponse(port, settings, messages) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxTokens,
      stream: true,
      system: SYSTEM_PROMPT,
      messages: messages,
    }),
  });

  if (!response.ok) {
    let errorMsg = `API error ${response.status}`;
    try {
      const errorBody = await response.json();
      errorMsg += `: ${errorBody.error?.message || JSON.stringify(errorBody)}`;
    } catch {
      errorMsg += `: ${response.statusText}`;
    }
    port.postMessage({ type: "sidechat-error", error: errorMsg });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);

        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        ) {
          port.postMessage({
            type: "sidechat-delta",
            text: event.delta.text,
          });
        } else if (event.type === "message_stop") {
          port.postMessage({ type: "sidechat-done" });
        } else if (event.type === "error") {
          port.postMessage({
            type: "sidechat-error",
            error: event.error?.message || "Stream error",
          });
        }
      } catch {
        // Skip non-JSON lines (e.g., event: type lines)
      }
    }
  }

  // Ensure done is sent even if message_stop wasn't received
  port.postMessage({ type: "sidechat-done" });
}
