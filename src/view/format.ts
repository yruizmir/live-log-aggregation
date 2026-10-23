export const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

export const shortTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export const formatTime = (timestamp: number, raw: string) => (Number.isNaN(timestamp) ? raw : timeFormat.format(timestamp));

/** Copies text when the renderer allows it; quietly does nothing when it does not. */
export const copyText = (text: string) => {
  try {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  } catch {
    // No clipboard here.
  }
};

const month = new Intl.DateTimeFormat("en-US", { month: "short" });
const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** `Oct 02 13:47:23.227`: the date column of the list. */
export const formatDate = (timestamp: number, raw: string) => {
  if (Number.isNaN(timestamp)) {
    return raw;
  }

  const date = new Date(timestamp);

  return `${month.format(date)} ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

// klog's header, `W1002 10:48:24.885238       1 leaderelection.go:325] message`: the date is in the
// date column already, so only the source file is kept, set apart from the message.
const klogHeader = /^[IWEFD]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+([^\s\]]+)\]\s?/;

export const splitSource = (text: string): { readonly source?: string; readonly rest: string } => {
  const match = klogHeader.exec(text);

  return match ? { source: match[1], rest: text.slice(match[0].length) } : { rest: text };
};

const csvCell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export const toCsv = (rows: readonly (readonly string[])[]) => rows.map((row) => row.map(csvCell).join(",")).join("\r\n");

interface SaveFilePicker {
  readonly showSaveFilePicker?: (options: {
    readonly suggestedName: string;
    readonly types: readonly { readonly description: string; readonly accept: Record<string, readonly string[]> }[];
  }) => Promise<{ createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> }>;
}

/**
 * Asks where to save the text, with the system's save dialog. Lens drops plain browser downloads,
 * so without that dialog the text goes to the clipboard; says which of the two it did.
 */
export const saveFile = async (name: string, text: string, extension: string, description: string): Promise<"saved" | "copied" | "cancelled"> => {
  const picker = (window as unknown as SaveFilePicker).showSaveFilePicker;

  if (picker) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description, accept: { "text/plain": [extension] } }] });
      const writable = await handle.createWritable();

      await writable.write(text);
      await writable.close();

      return "saved";
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return "cancelled";
      }
    }
  }

  copyText(text);

  return "copied";
};
