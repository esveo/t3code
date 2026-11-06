import type { ExpoConfig } from "expo/config";

// Fork: the esveo code Android APK (fork-android-apk.yml), opt in with T3CODE_ESVEO_ANDROID=1;
// without it the config stays upstream's. It uses upstream's production Clerk and relay config
// under a package of its own, so plugins/withEsveoClerkCallback.cjs keeps sign-in on the only
// callback Clerk allows, clerk://com.t3tools.t3code.callback.

const ESVEO_ASSETS = {
  "./assets/android-icon-foreground.png": "./assets/esveo/icon-foreground.png",
  "./assets/android-icon-mark.png": "./assets/esveo/icon-monochrome.png",
  "./assets/android-splash-icon-prod.png": "./assets/esveo/splash-icon.png",
  "./assets/android-notification-icon.png": "./assets/esveo/notification-icon.png",
} as const;

// Swaps upstream's Android artwork wherever the config or a plugin option references it.
function replaceAssets<T>(value: T): T {
  if (typeof value === "string") {
    return ((ESVEO_ASSETS as Record<string, string>)[value] ?? value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(replaceAssets) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceAssets(entry)]),
    ) as T;
  }
  return value;
}

export function withEsveoAndroid(config: ExpoConfig, env: Record<string, string | undefined>) {
  if (env.T3CODE_ESVEO_ANDROID !== "1") {
    return config;
  }
  const esveo = replaceAssets(config);
  esveo.plugins = [
    ...(esveo.plugins ?? []),
    "./plugins/withEsveoVersionName.cjs",
    "./plugins/withEsveoClerkCallback.cjs",
  ];
  return {
    ...esveo,
    name: "esveo code",
    scheme: "esveo-code",
    // Upstream's OTA channel would ship upstream's JS bundle into this binary.
    updates: { ...esveo.updates, enabled: false },
    // Read by src/features/esveoBrand/esveoBuild.ts to swap in the esveo lockup.
    extra: { ...esveo.extra, esveo: true },
    android: {
      ...esveo.android,
      package: "com.esveo.code",
      // Android only installs an update over a lower versionCode; the build script passes the commit count.
      versionCode: Number(env.T3CODE_ESVEO_VERSION_CODE) || 1,
      adaptiveIcon: {
        ...esveo.android?.adaptiveIcon,
        backgroundColor: "#0b4e86",
        backgroundImage: "./assets/esveo/icon-background.png",
      },
    },
    plugins: esveo.plugins?.map((plugin) => {
      if (!Array.isArray(plugin)) return plugin;
      if (plugin[0] === "expo-notifications") {
        return [plugin[0], { ...plugin[1], color: "#68e5de" }];
      }
      return plugin;
    }),
  } satisfies ExpoConfig;
}
