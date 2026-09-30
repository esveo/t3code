const { withAndroidManifest } = require("expo/config-plugins");

// Fork: esveo code installs as its own package but signs in through upstream's Clerk instance,
// which only allows the OAuth callback of upstream's package. The meta-data tells the patched
// @clerk/expo (patches/@clerk__expo@4.6.8.patch) to build its callback URL from that id, and the
// intent filters let the browser hand the callback back to this app. See esveo.config.ts.
const CLERK_APPLICATION_ID = "com.t3tools.t3code";
const SSO_RECEIVER = "com.clerk.api.sso.SSOReceiverActivity";

module.exports = function withEsveoClerkCallback(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (application == null) {
      throw new Error("AndroidManifest.xml is missing the application element.");
    }

    application["meta-data"] = [
      ...(application["meta-data"] ?? []),
      { $: { "android:name": "esveo.clerkApplicationId", "android:value": CLERK_APPLICATION_ID } },
    ];

    // Merges with the activity clerk-android declares for this app's own package.
    application.activity = [
      ...(application.activity ?? []),
      {
        $: { "android:name": SSO_RECEIVER, "android:exported": "true" },
        "intent-filter": ["callback", "oauth"].map((suffix) => ({
          action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
          category: [
            { $: { "android:name": "android.intent.category.DEFAULT" } },
            { $: { "android:name": "android.intent.category.BROWSABLE" } },
          ],
          data: [
            {
              $: { "android:scheme": "clerk", "android:host": `${CLERK_APPLICATION_ID}.${suffix}` },
            },
          ],
        })),
      },
    ];

    return next;
  });
};
