// Shared by every upload/JV page's "download as file" buttons.

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can race the browser's blob read on some
  // versions and truncate the download — give it a moment first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function todayIso() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** First day of the current month, as an ISO "YYYY-MM-DD" (HTML date input default). */
export function firstOfMonthIso() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-01`;
}
