/**
 * The offscreen document's one job: empty the clipboard when the background
 * asks. `navigator.clipboard` needs a focused page, which this never is, so
 * it uses a copy event and sets the copied text to nothing.
 */
chrome.runtime.onMessage.addListener((request: { kind?: string }, _sender, sendResponse) => {
  if (request.kind !== 'helm-clear-clipboard') return false;
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/plain', '');
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  sendResponse({ cleared: true });
  return false;
});
