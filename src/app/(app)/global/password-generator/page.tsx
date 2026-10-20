import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { PasswordGenerator } from '@/components/password-generator';

/**
 * A password generator on its own, for a system Helm does not hold — a router
 * being set up on a bench, a client's new mailbox. The same generator sits
 * beside every credential field, where it fills the field instead.
 *
 * Nothing here talks to the server: the password is made in the browser.
 */
export default function PasswordGeneratorPage() {
  return (
    <>
      <PageHeader
        title="Password generator"
        description="Made in your browser and never sent anywhere. Copy it, or use the Generate button beside any credential field to fill it in."
        trail={[{ label: 'Global', href: '/global' }]}
      />
      <PageBody>
        <Card className="max-w-md">
          <CardContent className="pt-5">
            <PasswordGenerator standalone />
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
