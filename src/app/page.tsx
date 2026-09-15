import { redirect } from 'next/navigation';

/**
 * The root is a redirect, not a landing page.
 *
 * Every useful surface in Helm is authenticated and tenant-scoped, and a public
 * page at `/` would be one more thing to keep free of anything worth knowing.
 * /dashboard renders inside the (app) layout, which resolves identity.
 */
export default function Root() {
  redirect('/dashboard');
}
