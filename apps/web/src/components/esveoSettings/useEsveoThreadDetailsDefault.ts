import { useLayoutEffect } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { setEsveoThreadPanelOpenByDefault } from "../../rightPanelStore";

/** Fork: feeds the `threadDetailsOpenByDefault` setting into the right panel store. */
export function useEsveoThreadDetailsDefault(): void {
  const openByDefault = useClientSettings((settings) => settings.threadDetailsOpenByDefault);
  useLayoutEffect(() => {
    setEsveoThreadPanelOpenByDefault(openByDefault);
  }, [openByDefault]);
}
