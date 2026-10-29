import { Download, ListChecks, Puzzle, ShieldAlert } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PairedBrowsersCard } from '@/components/paired-browsers-card';
import { listMyBrowsers } from '@/lib/extension/pairing';
import { EXTENSION_DOWNLOAD_URL, EXTENSION_RELEASES_URL } from '@/lib/extension/download';
import { requestOrigin } from '@/lib/settings/origin';

export const dynamic = 'force-dynamic';

/**
 * Personal → Browser extension: get it, set it up, and the browsers you have
 * paired (1120, 1121).
 *
 * The steps name this server's own address, because that is the one thing
 * the extension asks for that a person might not know.
 */
export default async function PersonalBrowserExtensionPage() {
  const identity = await getServerIdentity();
  const origin = await requestOrigin();
  const membership = identity.memberships.find((m) => m.tenantId === identity.tenantId);
  const allowed = membership?.orgScopeAll === true;

  const browsers = allowed ? await withTenant(actorOf(identity), (tx) => listMyBrowsers(tx)) : [];

  return (
    <>
      <PageHeader
        title="Browser extension"
        description="Fill, save and copy credentials from Chrome, Edge or Brave, for the site you are on."
        trail={[{ label: 'Personal', href: '/personal' }]}
      />
      <PageBody>
        {!allowed ? (
          <Card>
            <CardContent className="flex items-start gap-3 py-6 text-sm text-ink-muted">
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-sev-warning" aria-hidden />
              The browser extension is for MSP staff. Your role in {identity.tenantName} is a client-side
              one, so it is not available to you.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Download className="size-4 text-ink-faint" aria-hidden /> Get the extension
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-ink-muted">
                    One download for Chrome, Edge and Brave. It shows the credentials Helm has for the
                    site you are on and searches the rest. Click a credential to fill the sign-in form, or
                    copy its username, standard password or one-time code. It can also show Helm in sign-in
                    fields, offer to save a login after you sign in, and update a password that changed.
                    Elevated and critical passwords stay in Helm. Every fill, copy and save is audited.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button asChild variant="primary">
                      <a href={EXTENSION_DOWNLOAD_URL}>
                        <Download aria-hidden /> Download helm-extension.zip
                      </a>
                    </Button>
                    <a href={EXTENSION_RELEASES_URL} className="text-brand hover:underline" target="_blank" rel="noreferrer">
                      All versions
                    </a>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ListChecks className="size-4 text-ink-faint" aria-hidden /> Set it up
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="list-decimal space-y-2 pl-5 text-sm text-ink">
                    <li>Unzip the download into a folder you will keep. The browser loads it from there.</li>
                    <li>
                      Open <code className="rounded bg-surface-sunken px-1">chrome://extensions</code>,{' '}
                      <code className="rounded bg-surface-sunken px-1">brave://extensions</code> or{' '}
                      <code className="rounded bg-surface-sunken px-1">edge://extensions</code>, turn on{' '}
                      <strong>Developer mode</strong>, choose <strong>Load unpacked</strong> and pick the folder.
                    </li>
                    <li>Pin the Helm icon to the toolbar and click it. Until it is paired, it opens on its settings.</li>
                    <li>
                      Enter this Helm&rsquo;s address,{' '}
                      <code className="rounded bg-surface-sunken px-1">{origin}</code>, save, and allow
                      access when the browser asks.
                    </li>
                    <li>
                      Press <strong>Pair with Helm</strong>. In the tab that opens, check the fingerprint
                      matches the extension&rsquo;s, enter your Helm password (and authenticator code, if
                      you use one) and press <strong>Pair</strong>.
                    </li>
                  </ol>
                  <p className="mt-3 text-xs text-ink-muted">
                    To update, download the new version, unzip it over the same folder, and press the
                    reload button on the extension in the extensions page. Your pairing is kept. A browser
                    paired before version 0.5.0 is paired again (gear, then <strong>Pair again</strong>) to
                    save logins.
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Puzzle className="size-4 text-ink-faint" aria-hidden /> Your paired browsers
                </CardTitle>
              </CardHeader>
              <CardContent>
                <PairedBrowsersCard browsers={browsers} />
              </CardContent>
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}
