(() => {
  "use strict";

  const root = document.documentElement;
  const languageButtons = Array.from(document.querySelectorAll("[data-language-button]"));
  const copyButton = document.querySelector("[data-copy-command]");
  const copyStatus = document.getElementById("copy-status");
  const installCommand = document.getElementById("install-command");
  const description = document.querySelector('meta[name="description"]');
  const masthead = document.querySelector(".masthead");
  const homeLink = document.querySelector(".wordmark");
  const endnotes = document.querySelector(".endnotes");
  const letterArtTitle = document.getElementById("letter-art-title");
  const letterArtDescription = document.getElementById("letter-art-desc");
  const journeyArtTitle = document.getElementById("journey-art-title");
  const journeyArtDescription = document.getElementById("journey-art-desc");

  const localizedText = {
    en: {
      title: "Opened by code, hidden from people",
      description: "A warm visual essay about how protected code can briefly open a coding prompt without exposing it to a person.",
      header: "Site header",
      home: "Back to the beginning",
      endnotes: "Technical endnotes and repository colophon",
      artTitle: "HTTPS front desk versus a sealed request body",
      artDescription: "HTTPS protects both routes while they travel to the front desk. Ordinarily the desk receives a readable request body. The add-on keeps that body in a closed envelope beyond the desk.",
      journeyArtTitle: "A sealed prompt traveling between two protected rooms",
      journeyArtDescription: "Three separate paths each carry a sealed envelope. The internet front desk has no prompt view. Protected code briefly opens and reseals the prompt inside the coordinator room and the selected provider room, while people remain outside.",
      copied: "Setup commands copied.",
      copyFailed: "Copy is unavailable here. Select the commands above instead.",
      copyLabel: "Copy",
      copiedLabel: "Copied"
    },
    zh: {
      title: "由程式碼解封，沒有人能看得到",
      description: "一篇溫暖的圖文短論：受保護的程式碼如何短暫解封程式提示詞，卻不讓任何人看見。",
      header: "網站頁首",
      home: "回到文章開頭",
      endnotes: "技術附註與專案附記",
      artTitle: "HTTPS 網路櫃檯與密封請求內容的對照",
      artDescription: "HTTPS 會保護兩條路徑前往網路櫃檯的旅程。一般情況下，櫃檯收到可讀的請求內容；外掛則讓內容以密封信封通過櫃檯。",
      journeyArtTitle: "密封提示詞在兩間受保護的房間之間穿梭",
      journeyArtDescription: "三段各自分開的路徑上都有一封密封信。網路櫃檯看不到提示詞；受保護的程式碼只在協調器房間與獲選供應端房間內短暫解封並重封，所有人都留在房外。",
      copied: "安裝指令已複製。",
      copyFailed: "此處無法自動複製，請手動選取上方指令。",
      copyLabel: "複製",
      copiedLabel: "已複製"
    }
  };

  let currentLanguage = "en";
  let copyResetTimer;

  function readStoredLanguage() {
    try {
      const stored = window.localStorage.getItem("omp-darkbloom-language");
      return stored === "en" || stored === "zh" ? stored : null;
    } catch (_error) {
      return null;
    }
  }

  function browserLanguage() {
    try {
      const locale = Array.isArray(window.navigator.languages) && window.navigator.languages.length
        ? window.navigator.languages[0]
        : window.navigator.language;
      return typeof locale === "string" && locale.toLowerCase().startsWith("zh") ? "zh" : "en";
    } catch (_error) {
      return "en";
    }
  }

  function storeLanguage(language) {
    try {
      window.localStorage.setItem("omp-darkbloom-language", language);
    } catch (_error) {
      // The switch still works when storage is blocked or unavailable.
    }
  }

  function setCopyButtonText(language, copied) {
    if (!copyButton) return;
    const english = copyButton.querySelector('[data-copy="en"]');
    const chinese = copyButton.querySelector('[data-copy="zh"]');
    if (english) english.textContent = copied ? localizedText.en.copiedLabel : localizedText.en.copyLabel;
    if (chinese) chinese.textContent = copied ? localizedText.zh.copiedLabel : localizedText.zh.copyLabel;
    copyButton.setAttribute("aria-label", copied ? localizedText[language].copiedLabel : localizedText[language].copyLabel);
  }

  function resetCopyButton() {
    if (!copyButton) return;
    window.clearTimeout(copyResetTimer);
    delete copyButton.dataset.copied;
    setCopyButtonText(currentLanguage, false);
  }

  function setLanguage(language, persist = true) {
    currentLanguage = language === "zh" ? "zh" : "en";
    const text = localizedText[currentLanguage];

    root.dataset.language = currentLanguage;
    root.lang = currentLanguage === "zh" ? "zh-Hant" : "en";
    document.title = text.title;
    if (description) description.content = text.description;
    if (masthead) masthead.setAttribute("aria-label", text.header);
    if (homeLink) homeLink.setAttribute("aria-label", text.home);
    if (endnotes) endnotes.setAttribute("aria-label", text.endnotes);
    if (letterArtTitle) letterArtTitle.textContent = text.artTitle;
    if (letterArtDescription) letterArtDescription.textContent = text.artDescription;
    if (journeyArtTitle) journeyArtTitle.textContent = text.journeyArtTitle;
    if (journeyArtDescription) journeyArtDescription.textContent = text.journeyArtDescription;

    languageButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.languageButton === currentLanguage));
    });

    if (copyStatus) copyStatus.textContent = "";
    resetCopyButton();
    if (persist) storeLanguage(currentLanguage);
  }

  function fallbackCopy(value) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let copied = false;
    try {
      copied = typeof document.execCommand === "function" && document.execCommand("copy");
    } catch (_error) {
      copied = false;
    }
    textarea.remove();
    return copied;
  }

  async function copyText(value) {
    try {
      if (window.navigator.clipboard && typeof window.navigator.clipboard.writeText === "function") {
        await window.navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_error) {
      // Older browsers and non-secure origins can still use the selection fallback.
    }
    return fallbackCopy(value);
  }

  async function handleCopy() {
    if (!copyButton || !copyStatus || !installCommand) return;
    const copied = await copyText(installCommand.textContent.trim());
    copyStatus.textContent = copied ? localizedText[currentLanguage].copied : localizedText[currentLanguage].copyFailed;
    if (!copied) return;

    copyButton.dataset.copied = "true";
    setCopyButtonText(currentLanguage, true);
    copyResetTimer = window.setTimeout(resetCopyButton, 2400);
  }

  languageButtons.forEach((button) => {
    button.addEventListener("click", () => setLanguage(button.dataset.languageButton));
  });
  if (copyButton) copyButton.addEventListener("click", handleCopy);

  setLanguage(readStoredLanguage() || browserLanguage(), false);
})();
