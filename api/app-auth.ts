/**
 * GET /app-auth?privy_oauth_code=...&privy_oauth_state=...&privy_oauth_provider=...
 * (rewritten here from https://www.ratpool.xyz/app-auth, see vercel.json)
 *
 * Where Privy sends a Google sign-in started inside the Android app. It answers
 * with a redirect straight into the app, `ratpool://auth?<same query>`, sent as
 * an Android intent addressed to the RatPool package only, so the one-time code
 * cannot be handed to anything else.
 *
 * Why a server redirect and not a page: the sign-in runs in a secure browser
 * tab, and a tab only opens an app from a navigation the user started. A
 * redirect is part of the navigation that began with the tap on the Google
 * account, so the tab honours it; a page that tries the same from JavaScript
 * a moment later is refused, which is how the owner ended up on a "Return to
 * RatPool" page. That page stays as the intent's fallback.
 *
 * Nothing is read or kept here: the code is only meaningful to the web view
 * that started the sign-in, which holds the other half of the handshake.
 */
export function GET(req: Request): Response {
  const query = new URL(req.url).search;
  const fallback = `https://www.ratpool.xyz/app-auth/manual/${query}`;
  const intent =
    `intent://auth${query}#Intent;scheme=ratpool;package=xyz.ratpool.app;` +
    `S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
  return new Response(null, { status: 302, headers: { location: intent, "cache-control": "no-store" } });
}
