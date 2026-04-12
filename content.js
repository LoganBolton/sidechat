// =============================================================================
// Sidechat Content Script
// Runs on claude.ai — handles DOM scraping, overlay panel, and API communication
// =============================================================================

(() => {
  "use strict";

  const MAX_TURNS = 20;
  let panelHost = null; // The Shadow DOM host element
  let shadowRoot = null;
  let currentPort = null;
  let branchHistory = []; // Follow-up conversation history
  let currentSelectedText = "";

  // =========================================================================
  // DOM Conversation Scraper
  // =========================================================================

  function scrapeConversation() {
    const turns = [];

    // Strategy 1: data-testid attributes
    const userMsgs = document.querySelectorAll('[data-testid^="user-message"]');
    const asstMsgs = document.querySelectorAll(
      '[data-testid^="assistant-message"]'
    );
    if (userMsgs.length > 0 || asstMsgs.length > 0) {
      return scrapeByTestId(userMsgs, asstMsgs);
    }

    // Strategy 2: Walk the conversation container looking for message pairs
    const conversationTurns = scrapeByDOMWalk();
    if (conversationTurns.length > 0) return conversationTurns;

    // Strategy 3: Fallback — grab all text blocks with role heuristics
    return scrapeByHeuristic();
  }

  function scrapeByTestId(userMsgs, asstMsgs) {
    const allMsgs = [];

    userMsgs.forEach((el) => {
      allMsgs.push({
        role: "user",
        content: extractTextContent(el),
        order: getDocumentOrder(el),
      });
    });

    asstMsgs.forEach((el) => {
      allMsgs.push({
        role: "assistant",
        content: extractTextContent(el),
        order: getDocumentOrder(el),
      });
    });

    allMsgs.sort((a, b) => a.order - b.order);
    return allMsgs.map(({ role, content }) => ({ role, content }));
  }

  function scrapeByDOMWalk() {
    // Look for the main conversation thread container
    // Claude.ai typically renders messages in a scrollable container
    const turns = [];

    // Find message containers — look for elements that contain both user and assistant messages
    // Claude uses a structure where each message group has distinguishing characteristics
    const messageGroups = document.querySelectorAll(
      '[class*="message"], [class*="Message"], [data-is-streaming]'
    );

    // Try to find the conversation wrapper by looking for a container with multiple
    // child divs that look like alternating messages
    const candidates = document.querySelectorAll("main [role='presentation'], main > div > div > div");

    for (const container of candidates) {
      const children = Array.from(container.children);
      if (children.length < 2) continue;

      for (const child of children) {
        const role = classifyMessageElement(child);
        if (role) {
          const content = extractTextContent(child);
          if (content.trim()) {
            turns.push({ role, content });
          }
        }
      }

      if (turns.length >= 2) return turns;
    }

    // Another approach: look for the chat log / thread
    const threadEl =
      document.querySelector('[class*="thread"]') ||
      document.querySelector('[class*="Thread"]') ||
      document.querySelector('[class*="conversation"]') ||
      document.querySelector('[class*="Conversation"]');

    if (threadEl) {
      const children = Array.from(threadEl.children);
      for (const child of children) {
        const role = classifyMessageElement(child);
        if (role) {
          const content = extractTextContent(child);
          if (content.trim()) {
            turns.push({ role, content });
          }
        }
      }
    }

    return turns;
  }

  function scrapeByHeuristic() {
    const turns = [];

    // Look for human/user turns by avatar or name indicators
    const allBlocks = document.querySelectorAll(
      '[class*="human"], [class*="Human"], [class*="user"], [class*="User"], ' +
        '[class*="assistant"], [class*="Assistant"], [class*="claude"], [class*="Claude"], ' +
        '[class*="response"], [class*="Response"]'
    );

    for (const block of allBlocks) {
      const role = classifyMessageElement(block);
      if (role) {
        const content = extractTextContent(block);
        if (content.trim()) {
          turns.push({ role, content });
        }
      }
    }

    return turns;
  }

  function classifyMessageElement(el) {
    const className = (typeof el.className === "string" ? el.className : "").toLowerCase();
    const testId = (el.getAttribute("data-testid") || "").toLowerCase();

    // Check for user/human indicators
    if (
      testId.includes("user") ||
      testId.includes("human") ||
      className.includes("human") ||
      className.includes("user-message")
    ) {
      return "user";
    }

    // Check for assistant/claude indicators
    if (
      testId.includes("assistant") ||
      testId.includes("claude") ||
      className.includes("assistant") ||
      className.includes("claude") ||
      className.includes("response")
    ) {
      return "assistant";
    }

    // Look for avatar images as a hint
    const imgs = el.querySelectorAll("img");
    for (const img of imgs) {
      const alt = (img.alt || "").toLowerCase();
      const src = (img.src || "").toLowerCase();
      if (alt.includes("claude") || src.includes("claude")) return "assistant";
      if (alt.includes("user") || alt.includes("you")) return "user";
    }

    return null;
  }

  function extractTextContent(el) {
    // Clone the element and remove UI-only elements
    const clone = el.cloneNode(true);

    // Remove buttons, toolbars, icon containers
    const removeSelectors = [
      "button",
      '[role="toolbar"]',
      '[class*="action"]',
      '[class*="Action"]',
      '[class*="toolbar"]',
      '[class*="Toolbar"]',
      '[class*="copy"]',
      '[class*="Copy"]',
      '[class*="thumb"]',
      '[class*="Thumb"]',
      '[class*="feedback"]',
      '[class*="Feedback"]',
      "svg",
    ];

    for (const sel of removeSelectors) {
      clone.querySelectorAll(sel).forEach((node) => node.remove());
    }

    // Handle images
    clone.querySelectorAll("img").forEach((img) => {
      const alt = img.alt || "image";
      img.replaceWith(`[${alt}]`);
    });

    // Handle file attachments
    clone.querySelectorAll('[class*="attachment"], [class*="Attachment"]').forEach((att) => {
      const name = att.textContent?.trim() || "file";
      att.replaceWith(`[file: ${name}]`);
    });

    return clone.textContent?.trim() || "";
  }

  function getDocumentOrder(el) {
    // Use a TreeWalker-friendly approach: collect position relative to body
    const range = document.createRange();
    range.selectNode(el);
    const rect = range.getBoundingClientRect();
    // Use vertical position as primary sort, horizontal as tiebreaker
    return rect.top * 100000 + rect.left;
  }

  // =========================================================================
  // Markdown Renderer (lightweight, regex-based)
  // =========================================================================

  function renderMarkdown(text) {
    // Escape HTML first
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Code blocks (``` ... ```)
    html = html.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_, lang, code) =>
        `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`
    );

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

    // Links
    html = html.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );

    // Unordered lists
    html = html.replace(/^[\s]*[-*]\s+(.+)$/gm, "<li>$1</li>");
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

    // Ordered lists
    html = html.replace(/^[\s]*\d+\.\s+(.+)$/gm, "<li>$1</li>");

    // Paragraphs (double newline)
    html = html.replace(/\n\n+/g, "</p><p>");
    html = `<p>${html}</p>`;

    // Single newlines to <br>
    html = html.replace(/\n/g, "<br>");

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, "");

    return html;
  }

  // =========================================================================
  // Theme Detection
  // =========================================================================

  function detectTheme() {
    const root = document.documentElement;
    const theme = root.getAttribute("data-theme") || "";
    const classes = root.className || "";

    if (
      theme.includes("dark") ||
      classes.includes("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    return "light";
  }

  // =========================================================================
  // Overlay Panel
  // =========================================================================

  const MODEL_LABELS = {
    "claude-sonnet-4-20250514": "Sonnet 4",
    "claude-haiku-4-5-20251001": "Haiku 4.5",
    "claude-opus-4-6": "Opus 4.6",
  };

  const THINKING_LABELS = {
    off: "No thinking",
    low: "Low thinking",
    medium: "Medium thinking",
    high: "High thinking",
  };

  async function createPanel(selectionText) {
    // Remove existing panel
    removePanel();

    currentSelectedText = selectionText;
    branchHistory = [];

    const settings = await chrome.storage.sync.get({
      model: "claude-sonnet-4-20250514",
      thinkingLevel: "off",
    });
    const modelLabel = MODEL_LABELS[settings.model] || settings.model;
    const thinkingLabel = THINKING_LABELS[settings.thinkingLevel] || settings.thinkingLevel;

    // Create Shadow DOM host
    panelHost = document.createElement("div");
    panelHost.id = "sidechat-host";
    panelHost.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:2147483647;width:420px;height:500px;";
    document.body.appendChild(panelHost);

    shadowRoot = panelHost.attachShadow({ mode: "open" });

    const theme = detectTheme();

    // Inject styles into shadow root
    const style = document.createElement("style");
    style.textContent = getShadowStyles();
    shadowRoot.appendChild(style);

    const earlyTurns = scrapeConversation();
    const msgCount = earlyTurns.length;
    const hasSelection = selectionText.length > 0;
    const placeholder = hasSelection
      ? "Ask about this selection..."
      : "Ask about this conversation...";

    // Build panel
    const panel = document.createElement("div");
    panel.className = `sidechat-panel ${theme}`;
    panel.innerHTML = `
      <div class="sidechat-titlebar">
        <span class="sidechat-title">Sidechat</span>
        <span class="sidechat-model-info">${escapeHtml(modelLabel)} · ${escapeHtml(thinkingLabel)}</span>
        <button class="sidechat-close" aria-label="Close">&times;</button>
      </div>
      <div class="sidechat-body">
        <div class="sidechat-messages">
          ${msgCount > 0 ? buildContextPreview(earlyTurns) : ""}
          ${hasSelection ? `<blockquote class="sidechat-selection">${escapeHtml(selectionText)}</blockquote>` : ""}
        </div>
        <div class="sidechat-input-area">
          <textarea class="sidechat-input" placeholder="${placeholder}" rows="2"></textarea>
          <button class="sidechat-submit">Submit</button>
        </div>
      </div>
    `;
    shadowRoot.appendChild(panel);

    // Wire up events
    const closeBtn = shadowRoot.querySelector(".sidechat-close");
    const submitBtn = shadowRoot.querySelector(".sidechat-submit");
    const textarea = shadowRoot.querySelector(".sidechat-input");
    const titlebar = shadowRoot.querySelector(".sidechat-titlebar");

    closeBtn.addEventListener("click", removePanel);

    submitBtn.addEventListener("click", () => handleSubmit(textarea));

    // Stop all keyboard/input events from bubbling to the main page
    ["keydown", "keyup", "keypress", "input", "beforeinput"].forEach((evt) => {
      textarea.addEventListener(evt, (e) => e.stopPropagation());
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(textarea);
      }
    });

    // Make draggable
    makeDraggable(titlebar, panelHost);

    // Make resizable
    panelHost.style.resize = "both";
    panelHost.style.overflow = "hidden";
    panelHost.style.minWidth = "300px";
    panelHost.style.minHeight = "300px";

    // Focus the textarea
    textarea.focus();

    // Animate in
    requestAnimationFrame(() => {
      panel.classList.add("sidechat-visible");
    });
  }

  function handleSubmit(textarea) {
    const question = textarea.value.trim();
    if (!question) return;

    textarea.value = "";
    textarea.disabled = true;

    const submitBtn = shadowRoot.querySelector(".sidechat-submit");
    submitBtn.disabled = true;

    const messagesContainer = shadowRoot.querySelector(".sidechat-messages");

    // Show user question in the panel
    const userMsg = document.createElement("div");
    userMsg.className = "sidechat-msg sidechat-msg-user";
    userMsg.textContent = question;
    messagesContainer.appendChild(userMsg);

    // Show thinking indicator
    const thinkingMsg = document.createElement("div");
    thinkingMsg.className = "sidechat-msg sidechat-msg-assistant sidechat-thinking";
    thinkingMsg.textContent = "Thinking...";
    messagesContainer.appendChild(thinkingMsg);

    // Scrape conversation
    let conversationTurns = scrapeConversation();

    if (conversationTurns.length === 0) {
      showWarning(
        messagesContainer,
        "Could not detect conversation context. Your question will be sent without prior context."
      );
    }

    // Truncate if too long
    if (conversationTurns.length > MAX_TURNS * 2) {
      const removed = conversationTurns.length - MAX_TURNS * 2;
      conversationTurns = conversationTurns.slice(-MAX_TURNS * 2);
      showWarning(
        messagesContainer,
        `Conversation truncated (removed ${removed} oldest messages) to fit context window.`
      );
    }

    // Open port and stream
    currentPort = chrome.runtime.connect({ name: "sidechat-stream" });

    let responseText = "";
    let firstToken = true;

    currentPort.onMessage.addListener((msg) => {
      if (msg.type === "sidechat-delta") {
        if (firstToken) {
          thinkingMsg.textContent = "";
          thinkingMsg.classList.remove("sidechat-thinking");
          firstToken = false;
        }
        responseText += msg.text;
        thinkingMsg.innerHTML = renderMarkdown(responseText);
      } else if (msg.type === "sidechat-done") {
        // Save to branch history
        branchHistory.push({ role: "user", content: question });
        branchHistory.push({ role: "assistant", content: responseText });

        // Re-enable input for follow-up
        textarea.disabled = false;
        submitBtn.disabled = false;
        textarea.placeholder = "Ask a follow-up...";
        textarea.focus();
      } else if (msg.type === "sidechat-error") {
        thinkingMsg.classList.remove("sidechat-thinking");
        thinkingMsg.className = "sidechat-msg sidechat-msg-error";
        thinkingMsg.textContent = msg.error;

        textarea.disabled = false;
        submitBtn.disabled = false;
      }
    });

    currentPort.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        thinkingMsg.classList.remove("sidechat-thinking");
        thinkingMsg.className = "sidechat-msg sidechat-msg-error";
        thinkingMsg.textContent =
          "Connection lost. Please try again.";
        textarea.disabled = false;
        submitBtn.disabled = false;
      }
    });

    currentPort.postMessage({
      type: "sidechat-submit",
      conversationTurns: conversationTurns,
      selectedText: currentSelectedText,
      question: question,
      branchHistory: branchHistory,
    });
  }

  function showWarning(container, text) {
    const warning = document.createElement("div");
    warning.className = "sidechat-warning";
    warning.textContent = text;
    container.appendChild(warning);
  }

  function removePanel() {
    if (panelHost) {
      const panel = shadowRoot?.querySelector(".sidechat-panel");
      if (panel) {
        panel.classList.remove("sidechat-visible");
        panel.classList.add("sidechat-closing");
        setTimeout(() => {
          panelHost?.remove();
          panelHost = null;
          shadowRoot = null;
        }, 200);
      } else {
        panelHost.remove();
        panelHost = null;
        shadowRoot = null;
      }
    }
    if (currentPort) {
      try {
        currentPort.disconnect();
      } catch {}
      currentPort = null;
    }
    branchHistory = [];
  }

  // =========================================================================
  // Draggable
  // =========================================================================

  function makeDraggable(handle, target) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".sidechat-close")) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = target.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      handle.style.cursor = "grabbing";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      target.style.left = startLeft + dx + "px";
      target.style.top = startTop + dy + "px";
      target.style.right = "auto";
      target.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        handle.style.cursor = "grab";
      }
    });
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  function buildContextPreview(turns) {
    const firstUser = turns.find((t) => t.role === "user");
    if (!firstUser) return "";
    return `<div class="sidechat-context-preview">${escapeHtml(firstUser.content)}</div>`;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // =========================================================================
  // Shadow DOM Styles
  // =========================================================================

  function getShadowStyles() {
    return `
      :host {
        all: initial;
        font-family: 'Anthropic Serif', Georgia, serif;
        font-size: 14px;
        line-height: 1.5;
      }

      .sidechat-panel {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
        opacity: 0;
        transform: translateY(10px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        overflow: hidden;

        /* Light theme defaults */
        --bg: #ffffff;
        --bg-secondary: #f5f5f5;
        --text: #1a1a1a;
        --text-muted: #666666;
        --border: #e0e0e0;
        --accent: #c97a3a;
        --accent-hover: #b56a2e;
        --quote-border: #c97a3a;
        --quote-bg: #faf6f1;
        --code-bg: #f0f0f0;
        --error-bg: #ffeaea;
        --error-text: #c62828;
        --warning-bg: #fff8e1;
        --warning-text: #f57f17;
        --user-msg-bg: #ede7f6;
        --scrollbar-thumb: #ccc;
      }

      .sidechat-panel.dark {
        --bg: #1e1e1e;
        --bg-secondary: #2a2a2a;
        --text: #e0e0e0;
        --text-muted: #999;
        --border: #3a3a3a;
        --accent: #d4955a;
        --accent-hover: #c97a3a;
        --quote-border: #d4955a;
        --quote-bg: #2a2418;
        --code-bg: #2a2a2a;
        --error-bg: #3d1c1c;
        --error-text: #ef9a9a;
        --warning-bg: #3d3418;
        --warning-text: #ffd54f;
        --user-msg-bg: #2d2640;
        --scrollbar-thumb: #555;
      }

      .sidechat-panel.sidechat-visible {
        opacity: 1;
        transform: translateY(0);
      }

      .sidechat-panel.sidechat-closing {
        opacity: 0;
        transform: translateY(10px);
      }

      .sidechat-titlebar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border);
        cursor: grab;
        user-select: none;
        border-radius: 12px 12px 0 0;
      }

      .sidechat-title {
        font-weight: 600;
        font-size: 13px;
        color: var(--text);
        letter-spacing: 0.02em;
      }

      .sidechat-model-info {
        font-size: 11px;
        color: var(--text-muted);
        margin-left: auto;
        margin-right: 8px;
        white-space: nowrap;
        font-style: italic;
      }

      .sidechat-close {
        background: none;
        border: none;
        font-size: 20px;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        border-radius: 4px;
      }

      .sidechat-close:hover {
        color: var(--text);
        background: var(--border);
      }

      .sidechat-body {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
        background: var(--bg);
        border-radius: 0 0 12px 12px;
      }

      .sidechat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .sidechat-messages::-webkit-scrollbar {
        width: 6px;
      }

      .sidechat-messages::-webkit-scrollbar-track {
        background: transparent;
      }

      .sidechat-messages::-webkit-scrollbar-thumb {
        background: var(--scrollbar-thumb);
        border-radius: 3px;
      }

      .sidechat-context-preview {
        font-size: 12px;
        color: var(--text-muted);
        padding: 8px 10px;
        border-radius: 6px;
        background: var(--bg-secondary);
        max-height: 60px;
        overflow: hidden;
        line-height: 1.4;
        -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 40%, rgba(0,0,0,0) 100%);
        mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 40%, rgba(0,0,0,0) 100%);
      }

      .sidechat-selection {
        margin: 0;
        padding: 8px 12px;
        background: var(--quote-bg);
        color: var(--text-muted);
        font-size: 13px;
        font-style: italic;
        border-radius: 6px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .sidechat-msg {
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 14px;
        color: var(--text);
        line-height: 1.55;
        word-break: break-word;
      }

      .sidechat-msg-user {
        background: var(--user-msg-bg);
        align-self: flex-end;
        max-width: 85%;
        border-radius: 8px 8px 2px 8px;
      }

      .sidechat-msg-assistant {
        background: var(--bg-secondary);
        align-self: flex-start;
        max-width: 95%;
      }

      .sidechat-msg-assistant p {
        margin: 0 0 8px 0;
      }

      .sidechat-msg-assistant p:last-child {
        margin-bottom: 0;
      }

      .sidechat-msg-assistant pre {
        background: var(--code-bg);
        padding: 10px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 8px 0;
      }

      .sidechat-msg-assistant code {
        font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
        font-size: 12.5px;
      }

      .sidechat-msg-assistant :not(pre) > code {
        background: var(--code-bg);
        padding: 1px 5px;
        border-radius: 3px;
      }

      .sidechat-msg-assistant ul,
      .sidechat-msg-assistant ol {
        margin: 6px 0;
        padding-left: 20px;
      }

      .sidechat-msg-assistant li {
        margin-bottom: 2px;
      }

      .sidechat-msg-assistant a {
        color: var(--accent);
        text-decoration: underline;
      }

      .sidechat-msg-assistant strong {
        font-weight: 600;
      }

      .sidechat-msg-error {
        background: var(--error-bg);
        color: var(--error-text);
        font-size: 13px;
      }

      .sidechat-warning {
        background: var(--warning-bg);
        color: var(--warning-text);
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 6px;
      }

      .sidechat-thinking {
        color: var(--text-muted);
        font-style: italic;
      }

      .sidechat-input-area {
        display: flex;
        gap: 8px;
        padding: 10px 14px;
        border-top: 1px solid var(--border);
        background: var(--bg);
      }

      .sidechat-input {
        flex: 1;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 13px;
        font-family: inherit;
        resize: none;
        outline: none;
        background: var(--bg);
        color: var(--text);
        line-height: 1.4;
        min-height: 36px;
        max-height: 120px;
      }

      .sidechat-input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgba(201, 122, 58, 0.15);
      }

      .sidechat-input:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .sidechat-submit {
        padding: 8px 16px;
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        align-self: flex-end;
      }

      .sidechat-submit:hover {
        background: var(--accent-hover);
      }

      .sidechat-submit:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    `;
  }

  // =========================================================================
  // Message Listeners
  // =========================================================================

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "sidechat-open") {
      createPanel(msg.selectionText || "");
    }
  });

  // =========================================================================
  // Navigation change detection — close panel on URL change
  // =========================================================================

  let lastUrl = location.href;

  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      removePanel();
    }
  });

  urlObserver.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("popstate", removePanel);
})();
