const { withAppBuildGradle } = require("expo/config-plugins");

// Fork: gives every esveo code build its own versionName (<version>-esveo.<versionCode>), which is
// also the tag of its GitHub release, so Obtainium can tell the installed build from a newer one.
// The JS side keeps reading upstream's version from the Expo config. See esveo.config.ts.
module.exports = function withEsveoVersionName(config) {
  return withAppBuildGradle(config, (next) => {
    const versionName = `${next.version}-esveo.${next.android.versionCode}`;
    next.modResults.contents = next.modResults.contents.replace(
      /versionName "[^"]*"/,
      `versionName "${versionName}"`,
    );
    return next;
  });
};
