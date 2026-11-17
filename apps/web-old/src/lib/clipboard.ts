/** Clipboard write with a fallback for non-secure origins (LAN over http). */
export const copyText = (text: string) => {
  void copyTextChecked(text);
};

/**
 * The same write, saying whether it happened: true once the text is on the clipboard, false when
 * neither the Clipboard API (absent outside a secure context) nor the fallback could copy it.
 */
export const copyTextChecked = async (text: string): Promise<boolean> => {
  if (typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallbackCopy(text);
    }
  }
  return fallbackCopy(text);
};

const fallbackCopy = (text: string): boolean => {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
};
