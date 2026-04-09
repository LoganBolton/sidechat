const apiKeyInput = document.getElementById("apiKey");
const toggleKeyBtn = document.getElementById("toggleKey");
const modelSelect = document.getElementById("model");
const maxTokensRange = document.getElementById("maxTokens");
const maxTokensValue = document.getElementById("maxTokensValue");
const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");

// Load saved settings
chrome.storage.sync.get(
  { apiKey: "", model: "claude-sonnet-4-20250514", maxTokens: 4096 },
  (items) => {
    apiKeyInput.value = items.apiKey;
    modelSelect.value = items.model;
    maxTokensRange.value = items.maxTokens;
    maxTokensValue.textContent = items.maxTokens;
  }
);

// Show/hide API key
toggleKeyBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleKeyBtn.textContent = isPassword ? "Hide" : "Show";
});

// Update range display
maxTokensRange.addEventListener("input", () => {
  maxTokensValue.textContent = maxTokensRange.value;
});

// Save settings
saveBtn.addEventListener("click", () => {
  chrome.storage.sync.set(
    {
      apiKey: apiKeyInput.value.trim(),
      model: modelSelect.value,
      maxTokens: parseInt(maxTokensRange.value, 10),
    },
    () => {
      status.textContent = "Saved!";
      setTimeout(() => {
        status.textContent = "";
      }, 2000);
    }
  );
});
