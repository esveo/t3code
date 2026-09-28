import Constants from "expo-constants";

/** Fork: true in the esveo code APK, which apps/mobile/esveo.config.ts marks in `extra`. */
export const IS_ESVEO_BUILD = Constants.expoConfig?.extra?.esveo === true;
