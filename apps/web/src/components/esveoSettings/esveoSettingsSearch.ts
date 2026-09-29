import { useEffect, useEffectEvent } from "react";

/** What the settings search is filled with to list every setting esveo's fork adds. */
export const ESVEO_SETTINGS_QUERY = "esveo";

const SEARCH_REQUEST_EVENT = "esveo:settings-search";

/** Fork: asks the settings sidebar to search for the fork's settings. */
export function requestEsveoSettingsSearch() {
  window.dispatchEvent(new Event(SEARCH_REQUEST_EVENT));
}

/** Fork: lets the settings sidebar answer `requestEsveoSettingsSearch` with its own query state. */
export function useEsveoSettingsSearchRequest(onRequest: (query: string) => void) {
  const handleRequest = useEffectEvent(() => onRequest(ESVEO_SETTINGS_QUERY));
  useEffect(() => {
    const listener = () => handleRequest();
    window.addEventListener(SEARCH_REQUEST_EVENT, listener);
    return () => window.removeEventListener(SEARCH_REQUEST_EVENT, listener);
  }, []);
}
