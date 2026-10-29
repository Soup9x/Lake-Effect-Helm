# Lake Effect Helm browser extension

Looks up the credentials for the site you are on, and fills or copies a
username, a standard password or a one-time code. Click a credential to fill
the sign-in form on the page; the icons beside it copy. Chrome, Edge and Brave,
from one build.

Since 0.5.0, as Bitwarden does: a Helm icon in sign-in fields that lists the
site's logins and fills one, an offer to save a login after you sign in (to
your own passwords, or a client and one of its locations, with tags) or to
update a password that changed, and a **+** in the popup to add a login by
hand. Settings live in the popup, including the timeout and whether it locks
or signs out. There is no password generator, on purpose.

How it is secured, and why, is in
[docs/architecture/01-security-model.md §4.6](../docs/architecture/01-security-model.md).

## Layout

| Path | What |
| --- | --- |
| `manifest.json` | Manifest V3. The version here is the store version. |
| `src/popup.ts` | The toolbar popup: matches for this tab, search, fill, copy, add a login, settings. |
| `src/settings.ts` | Settings, drawn in the popup and on the options page: pairing, lock, timeout, autofill, clipboard, theme. |
| `src/lock.ts` | The PIN or password lock: the token sealed at rest, unlocked in session memory; the timeout. |
| `src/fill.ts` | Finds and fills the sign-in form in the tab (runs in the page). |
| `src/content.ts` | In every https page, once turned on: the icon in sign-in fields, and noticing a sign-in. |
| `src/inpage.ts` | The background's half of that: the list, filling from it, the save and update prompt. |
| `src/menu.ts`, `src/notify.ts` | The list under a field, and the save prompt: extension pages the site cannot read. |
| `src/guard.ts` | Ignores clicks in those two while the page hides or covers them (clickjacking). |
| `src/picker.ts` | Where a login goes: your passwords, or a client, a location and tags. |
| `src/options.ts` | The options page: the same settings, on a page of their own. |
| `src/background.ts` | Finishes a pairing, renews the token daily, clears the clipboard, registers the page script. |
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

- **Single purpose**: look up, fill, save and copy credentials with the
  organisation's own Helm server.
- **Permissions**: `activeTab` (read the current tab's address when the popup
  is opened), `storage`, `scripting` (the pairing listener in the Helm tab,
  and the page script below), `alarms` (clipboard clearing, renewal, the
  timeout), `offscreen` and `clipboardWrite` (clearing the clipboard). Host
  access is optional: the one Helm address the person enters, and every https
  page only if they turn on the icon in sign-in fields or the save prompt.
- **Data use**: the extension handles authentication information. It sends the
  address of a page with a sign-in form, and a login the person just typed
  (to compare and, if they say so, save), to the organisation's own Helm
  server, and nothing to anybody else. A privacy policy URL is required for
  this disclosure.
