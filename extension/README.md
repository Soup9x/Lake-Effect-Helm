# Lake Effect Helm browser extension

Looks up the credentials for the site you are on and copies a username, a
standard password or a one-time code. Chrome, Edge and Brave, from one build.
It does not fill forms.

How it is secured, and why, is in
[docs/architecture/01-security-model.md §4.6](../docs/architecture/01-security-model.md).

## Layout

| Path | What |
| --- | --- |
| `manifest.json` | Manifest V3. The version here is the store version. |
| `src/popup.ts` | The toolbar popup: matches for this tab, search, copy. |
| `src/options.ts` | Settings: the Helm address, pairing, clipboard clearing. |
| `src/background.ts` | Finishes a pairing, renews the token daily, clears the clipboard. |
| `src/offscreen.ts` | Clears the clipboard (an offscreen page is the only way an extension can). |
| `src/api.ts` | Every call to Helm: the token plus the device-key signature. |
| `src/store.ts` | Where things are kept: chrome.storage for settings and the token, IndexedDB for the key. |
| `static/`, `icons/` | HTML, CSS and icons, copied as they are. |

It shares three files with the server, imported directly so the two sides
cannot drift: `src/lib/extension/signature.ts` (what a request signs),
`types.ts` (what the routes return) and `pairing-protocol.ts` (how pairing
talks).

## Download

Every version is published as a GitHub release by
`.github/workflows/extension-release.yml`. The newest one is always at:

```
https://github.com/Soup9x/Lake-Effect-Helm/releases/latest/download/helm-extension.zip
```

Unzip it and load the folder unpacked (below). A release is made when a push
to `main` raises `version` in `manifest.json`.

## Build

```bash
pnpm build:extension
```

Writes `dist/extension/` (load this unpacked) and
`dist/helm-extension-<version>.zip` (upload this to the store). `pnpm typecheck`
checks the extension as well as the server.

To try it: open `chrome://extensions` (or `brave://extensions`,
`edge://extensions`), turn on Developer mode, **Load unpacked**, and choose
`dist/extension`. Then open the extension's settings, enter the Helm address,
and press **Pair with Helm**. Pairing asks for the Helm password (and the
authenticator code, if the account has one).

People find the download link and these steps in Helm itself, under
Personal → Browser extension; administrators see every paired browser under
Administration → Browser extensions.

## Releasing

1. Raise `version` in `manifest.json`. The store refuses an upload that does
   not.
2. `pnpm build:extension`.
3. Upload the zip in the Chrome Web Store developer dashboard.

The listing is **unlisted** (only people with the link can install it).
Chrome and Brave install straight from the Web Store. Edge does too, after
**Allow extensions from other stores** is switched on once.

For managed machines, the store item's id can be force-installed with policy
(Intune or group policy: `ExtensionInstallForcelist`, with the update URL
`https://clients2.google.com/service/update2/crx`), and the Helm address is
still entered once per browser in the extension's settings.

### What the store asks

- **Single purpose**: look up and copy credentials from the organisation's own
  Helm server.
- **Permissions**: `activeTab` (read the current tab's address when the popup
  is opened), `storage`, `scripting` (the pairing listener in the Helm tab),
  `alarms` (clipboard clearing and renewal), `offscreen` and `clipboardWrite`
  (clearing the clipboard). Host access is optional and requested for the one
  Helm address the person enters.
- **Data use**: the extension handles authentication information. It sends the
  current tab's address to the organisation's own Helm server, and nothing to
  anybody else. A privacy policy URL is required for this disclosure.
