/**
 * WebView2's script API (`window.chrome.webview`), as far as the UI uses it. A plain browser (the
 * dev server opened in one) and the tests have no `chrome.webview`, hence everything is optional.
 * A script file, not a module: it only adds to the global `Window`.
 */

interface WebView2Api {
  /**
   * Posts `message` (any JSON-serialisable value) to the host with the `File` objects of a drop.
   * Only the host can read the files' paths (`ICoreWebView2File::Path`), the page never sees them.
   */
  postMessageWithAdditionalObjects(message: unknown, additionalObjects: ArrayLike<unknown>): void;
}

interface Window {
  chrome?: { webview?: WebView2Api };
}
