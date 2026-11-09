/** Settings → Your AI: save, test and forget the person's own provider key, in this browser only. */
import { ask, AiError, DEFAULT_MODELS, forgetAiSettings, providerName, readAiSettings, saveAiSettings, type AiProvider, type AiSettings } from "./ai";

const root = document.getElementById("ai-settings");

function field<T extends HTMLInputElement | HTMLSelectElement>(name: string): T {
  const el = root?.querySelector(`[name="${name}"]`);
  if (!el) throw new Error(`[mutinybim-web settings] the AI form has no ${name} field`);
  return el as T;
}

function setStatus(kind: "ok" | "error" | "info", text: string): void {
  const status = root?.querySelector(".status");
  if (!status) return;
  status.textContent = text;
  status.setAttribute("data-kind", kind);
}

function current(): AiSettings | null {
  const provider = field<HTMLSelectElement>("provider").value as AiProvider;
  const key = field<HTMLInputElement>("key").value.trim();
  if (!key) {
    setStatus("error", "Paste your API key first.");
    return null;
  }
  return { provider, key, model: field<HTMLInputElement>("model").value.trim(), baseUrl: field<HTMLInputElement>("baseUrl").value.trim() };
}

function showProvider(): void {
  const provider = field<HTMLSelectElement>("provider").value as AiProvider;
  root?.setAttribute("data-provider", provider);
  field<HTMLInputElement>("model").placeholder = DEFAULT_MODELS[provider] || "the model name your provider gives";
}

if (root) {
  const saved = readAiSettings();
  if (saved) {
    field<HTMLSelectElement>("provider").value = saved.provider;
    field<HTMLInputElement>("model").value = saved.model;
    field<HTMLInputElement>("baseUrl").value = saved.baseUrl;
    field<HTMLInputElement>("key").value = saved.key;
  }
  showProvider();
  root.setAttribute("data-state", "ready");
  setStatus("info", saved ? `A ${providerName(saved)} key is saved in this browser.` : "No key saved in this browser yet.");
  field<HTMLSelectElement>("provider").addEventListener("change", showProvider);

  root.querySelector('[data-action="save"]')?.addEventListener("click", () => {
    const settings = current();
    if (!settings) return;
    try {
      saveAiSettings(settings);
      setStatus("ok", `Saved in this browser. The editor's Ask AI button now uses your ${providerName(settings)} key.`);
    } catch (err) {
      console.error("[mutinybim-web settings] saving the key in this browser failed", err);
      setStatus("error", "This browser wouldn't save the key (private browsing can block it). Nothing was sent anywhere.");
    }
  });

  const testButton = root.querySelector<HTMLButtonElement>('[data-action="test"]');
  testButton?.addEventListener("click", async () => {
    const settings = current();
    if (!settings) return;
    testButton.disabled = true;
    setStatus("info", `Asking ${providerName(settings)} a one-line question…`);
    try {
      const answer = await ask(settings, { system: "Answer in five words or fewer.", question: "Say that the key works." });
      setStatus("ok", `${providerName(settings)} answered: “${answer.slice(0, 120)}”. The key works. Press Save to keep it.`);
    } catch (err) {
      setStatus("error", err instanceof AiError ? err.message : "The test failed for a reason this page can't name. Try again.");
      if (!(err instanceof AiError)) console.error("[mutinybim-web settings] key test failed", err);
    } finally {
      testButton.disabled = false;
    }
  });

  root.querySelector('[data-action="forget"]')?.addEventListener("click", () => {
    if (!window.confirm("Forget the AI key saved in this browser?")) return;
    forgetAiSettings();
    field<HTMLInputElement>("key").value = "";
    setStatus("ok", "Forgotten. No AI key is saved in this browser.");
  });
}
